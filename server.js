const http = require('http');
const { Pool } = require('pg');
const crypto = require('crypto');
const url = require('url');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
        'postgresql://niomero:MOXUCpO1XEu0gX3eb9jRn2rBrTwSwv0g@dpg-d9794s6q1p3s738kbbqg-a.oregon-postgres.render.com/ghost_db_vh94',
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    const client = await pool.connect();
    try {
        // Создаём таблицу если нет
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                login VARCHAR(64) UNIQUE NOT NULL,
                password_hash VARCHAR(128) NOT NULL,
                role VARCHAR(32) NOT NULL DEFAULT 'USER',
                premium BOOLEAN NOT NULL DEFAULT FALSE,
                hwid VARCHAR(256),
                created_at TIMESTAMP DEFAULT NOW(),
                banned BOOLEAN NOT NULL DEFAULT FALSE,
                ban_reason VARCHAR(256)
            )
        `);
        // Миграции: добавляем колонки если их нет
        const migrations = [
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(128)`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP`,
        ];
        for (const sql of migrations) {
            await client.query(sql);
        }
        // Первый пользователь Ghost
        const hash = sha256('ghosty');
        await client.query(`
            INSERT INTO users (login, email, password_hash, role, premium)
            VALUES ('Ghost', 'ghost@ghost.client', $1, 'OWNER', TRUE)
            ON CONFLICT (login) DO NOTHING
        `, [hash]);
        console.log('[DB] Initialized.');
    } finally {
        client.release();
    }
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('Invalid JSON')); }
        });
    });
}

function json(res, status, obj) {
    const data = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data, 'utf8'),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end(data);
}

function html(res, status, content) {
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
}

function getToken(req) {
    const auth = req.headers['authorization'] || '';
    return auth.replace('Bearer ', '').trim();
}

// Simple token store (production: use JWT or DB sessions)
const sessions = new Map(); // token -> userId

function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, ts: Date.now() });
    return token;
}

function getSessionUser(token) {
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.ts > 7 * 24 * 3600 * 1000) { sessions.delete(token); return null; }
    return s.userId;
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const path = parsed.pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
        });
        return res.end();
    }

    // ── GET /api/ping ──────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/ping') {
        return json(res, 200, { ok: true, service: 'Ghost Client API v2' });
    }

    // ── GET /api/launcher/version ──────────────────────────────
    // Лаунчер проверяет эту точку при запуске — если версия новее, предлагает обновление
    if (req.method === 'GET' && path === '/api/launcher/version') {
        return json(res, 200, { version: 'v1.0.0', download_url: 'https://ghost-client-api.onrender.com/api/launcher/download-exe' });
    }

    // ── GET /api/launcher/download-exe ────────────────────────
    // Редирект на актуальный .exe лаунчера (загрузи на GitHub Releases или другой хостинг)
    if (req.method === 'GET' && path === '/api/launcher/download-exe') {
        res.writeHead(302, { Location: 'https://github.com/Niomero/ghost-client-api/releases/latest/download/GhostClient.exe' });
        return res.end();
    }

    // ── POST /api/register ─────────────────────────────────────
    if (req.method === 'POST' && path === '/api/register') {
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { login, password, email } = body;
        if (!login || !password) return json(res, 400, { success: false, error: 'Заполните все поля' });
        if (login.length < 3 || login.length > 32) return json(res, 400, { success: false, error: 'Логин: 3–32 символа' });
        if (password.length < 4) return json(res, 400, { success: false, error: 'Пароль слишком короткий' });
        try {
            const r = await pool.query(
                'INSERT INTO users (login, email, password_hash) VALUES ($1, $2, $3) RETURNING id, login, role, premium, created_at',
                [login, email || null, sha256(password)]
            );
            const u = r.rows[0];
            const token = createSession(u.id);
            return json(res, 200, { success: true, token, user: { id: u.id, login: u.login, role: u.role, premium: u.premium, created_at: u.created_at } });
        } catch (e) {
            if (e.code === '23505') return json(res, 409, { success: false, error: 'Логин или email уже занят' });
            console.error('[register]', e.message);
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/login ────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/login') {
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { login, password, hwid } = body;
        if (!login || !password) return json(res, 400, { success: false, error: 'Заполните все поля' });
        try {
            const r = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
            if (!r.rows.length) return json(res, 401, { success: false, error: 'Неверный логин или пароль' });
            const u = r.rows[0];
            if (u.password_hash !== sha256(password)) return json(res, 401, { success: false, error: 'Неверный логин или пароль' });
            if (u.banned) return json(res, 403, { success: false, error: 'Аккаунт заблокирован: ' + (u.ban_reason || 'нарушение правил') });

            // HWID
            if (hwid) {
                if (!u.hwid) {
                    await pool.query('UPDATE users SET hwid = $1 WHERE id = $2', [hwid, u.id]);
                    u.hwid = hwid;
                } else if (u.hwid !== hwid) {
                    return json(res, 403, { success: false, error: 'Это устройство не привязано к аккаунту' });
                }
            }

            const token = createSession(u.id);
            const premiumActive = u.premium && (!u.premium_until || new Date(u.premium_until) > new Date());
            return json(res, 200, {
                success: true, token,
                user: {
                    id: u.id, login: u.login, role: u.role,
                    premium: premiumActive,
                    premium_until: u.premium_until,
                    hwid: u.hwid, created_at: u.created_at
                }
            });
        } catch (e) {
            console.error('[login]', e.message);
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── GET /api/me ────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/me') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        try {
            const r = await pool.query('SELECT id, login, email, role, premium, premium_until, hwid, created_at FROM users WHERE id = $1', [userId]);
            if (!r.rows.length) return json(res, 404, { success: false, error: 'Пользователь не найден' });
            const u = r.rows[0];
            const premiumActive = u.premium && (!u.premium_until || new Date(u.premium_until) > new Date());
            return json(res, 200, { success: true, user: { ...u, premium: premiumActive } });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/avatar ──────────────────────────────────────
    // Сохранить аватар пользователя (base64 dataURL)
    if (req.method === 'POST' && path === '/api/avatar') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { avatar } = body;
        if (!avatar || !avatar.startsWith('data:image/')) return json(res, 400, { success: false, error: 'Неверный формат аватара' });
        if (avatar.length > 500000) return json(res, 413, { success: false, error: 'Аватар слишком большой (макс 500KB)' });
        try {
            // Добавляем колонку если нет
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT`);
            await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, userId]);
            return json(res, 200, { success: true });
        } catch (e) {
            console.error('[avatar]', e.message);
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/reset-hwid ───────────────────────────────────
    if (req.method === 'POST' && path === '/api/reset-hwid') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        try {
            await pool.query('UPDATE users SET hwid = NULL WHERE id = $1', [userId]);
            return json(res, 200, { success: true, message: 'HWID сброшен. Теперь можно войти с нового устройства.' });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/logout ───────────────────────────────────────
    if (req.method === 'POST' && path === '/api/logout') {
        const token = getToken(req);
        if (token) sessions.delete(token);
        return json(res, 200, { success: true });
    }

    // ── POST /api/change-password ──────────────────────────────
    if (req.method === 'POST' && path === '/api/change-password') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { old_password, new_password } = body;
        if (!old_password || !new_password) return json(res, 400, { success: false, error: 'Заполните все поля' });
        if (new_password.length < 6) return json(res, 400, { success: false, error: 'Пароль минимум 6 символов' });
        try {
            const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
            if (!r.rows.length) return json(res, 404, { success: false, error: 'Пользователь не найден' });
            if (r.rows[0].password_hash !== sha256(old_password)) {
                return json(res, 403, { success: false, error: 'Неверный текущий пароль' });
            }
            await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [sha256(new_password), userId]);
            return json(res, 200, { success: true, message: 'Пароль успешно изменён' });
        } catch (e) {
            console.error('[change-password]', e.message);
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── GET /api/profile ───────────────────────────────────────
    // Алиас /api/me для совместимости с сайтом
    if (req.method === 'GET' && path === '/api/profile') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        try {
            const r = await pool.query(
                'SELECT id, login, email, role, premium, premium_until, hwid, created_at FROM users WHERE id = $1',
                [userId]
            );
            if (!r.rows.length) return json(res, 404, { success: false, error: 'Пользователь не найден' });
            const u = r.rows[0];
            const premiumActive = u.premium && (!u.premium_until || new Date(u.premium_until) > new Date());
            return json(res, 200, { success: true, user: { ...u, premium: premiumActive } });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/admin/reset-hwid ─────────────────────────────
    // Сброс HWID конкретного пользователя (только для OWNER/ADMIN)
    if (req.method === 'POST' && path === '/api/admin/reset-hwid') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        const adminCheck = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
        if (!adminCheck.rows.length || !['OWNER','ADMIN'].includes(adminCheck.rows[0].role)) {
            return json(res, 403, { success: false, error: 'Нет прав' });
        }
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { target_login } = body;
        if (!target_login) return json(res, 400, { success: false, error: 'Укажите target_login' });
        try {
            const r = await pool.query('UPDATE users SET hwid = NULL WHERE login = $1 RETURNING login', [target_login]);
            if (!r.rows.length) return json(res, 404, { success: false, error: 'Пользователь не найден' });
            return json(res, 200, { success: true, message: `HWID сброшен для ${target_login}` });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/admin/set-premium ────────────────────────────
    if (req.method === 'POST' && path === '/api/admin/set-premium') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        const adminCheck = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
        if (!adminCheck.rows.length || !['OWNER','ADMIN'].includes(adminCheck.rows[0].role)) {
            return json(res, 403, { success: false, error: 'Нет прав' });
        }
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { target_login, days } = body;
        if (!target_login || !days) return json(res, 400, { success: false, error: 'Укажите target_login и days' });
        const premiumUntil = new Date(Date.now() + Number(days) * 86400 * 1000).toISOString();
        try {
            const r = await pool.query(
                'UPDATE users SET premium = TRUE, premium_until = $1 WHERE login = $2 RETURNING login',
                [premiumUntil, target_login]
            );
            if (!r.rows.length) return json(res, 404, { success: false, error: 'Пользователь не найден' });
            return json(res, 200, { success: true, premium_until: premiumUntil });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/admin/ban ────────────────────────────────────
    if (req.method === 'POST' && path === '/api/admin/ban') {
        const token = getToken(req);
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Не авторизован' });
        const adminCheck = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
        if (!adminCheck.rows.length || !['OWNER','ADMIN'].includes(adminCheck.rows[0].role)) {
            return json(res, 403, { success: false, error: 'Нет прав' });
        }
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { target_login, reason, unban } = body;
        if (!target_login) return json(res, 400, { success: false, error: 'Укажите target_login' });
        try {
            if (unban) {
                await pool.query('UPDATE users SET banned = FALSE, ban_reason = NULL WHERE login = $1', [target_login]);
                return json(res, 200, { success: true, message: `${target_login} разбанен` });
            }
            await pool.query('UPDATE users SET banned = TRUE, ban_reason = $1 WHERE login = $2', [reason || 'Нарушение правил', target_login]);
            return json(res, 200, { success: true, message: `${target_login} заблокирован` });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── GET /api/launcher/download ─────────────────────────────
    if (req.method === 'GET' && path === '/api/launcher/download') {
        const token = getToken(req) || parsed.query.token;
        const userId = getSessionUser(token);
        if (!userId) return json(res, 401, { success: false, error: 'Требуется авторизация' });
        const r = await pool.query('SELECT premium FROM users WHERE id = $1', [userId]);
        if (!r.rows.length || !r.rows[0].premium) return json(res, 403, { success: false, error: 'Требуется Premium' });
        // Redirect to actual launcher download (подставьте реальную ссылку)
        res.writeHead(302, { Location: 'https://github.com/ghost-client/launcher/releases/latest/download/GhostClient.exe' });
        return res.end();
    }

    // ── POST /api/payment/telegram-stars ──────────────────────
    if (req.method === 'POST' && path === '/api/payment/telegram-stars') {
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Неверный формат' }); }
        const { userId, stars, invoicePayload } = body;

        // Здесь в production: проверка через Telegram Bot API
        // Пока принимаем и активируем premium на 30 дней
        if (!userId || !stars) return json(res, 400, { success: false, error: 'Недостаточно данных' });

        const days = stars >= 500 ? 365 : stars >= 200 ? 90 : stars >= 100 ? 30 : 0;
        if (!days) return json(res, 400, { success: false, error: `Недостаточно Stars. Минимум 100 Stars (30 дней)` });

        const premiumUntil = new Date(Date.now() + days * 86400 * 1000).toISOString();
        try {
            await pool.query('UPDATE users SET premium = TRUE, premium_until = $1 WHERE id = $2', [premiumUntil, userId]);
            return json(res, 200, { success: true, premium_until: premiumUntil, days });
        } catch (e) {
            return json(res, 500, { success: false, error: 'Ошибка сервера' });
        }
    }

    // ── POST /api/payment/verify-stars ─────────────────────────
    // Called by Telegram Bot after successful payment
    if (req.method === 'POST' && path === '/api/payment/verify-stars') {
        let body;
        try { body = await parseBody(req); } catch { return json(res, 400, {}); }
        const { telegram_payment_charge_id, user_id, stars } = body;
        if (!user_id) return json(res, 400, { success: false });
        const days = stars >= 500 ? 365 : stars >= 200 ? 90 : 30;
        const premiumUntil = new Date(Date.now() + days * 86400 * 1000).toISOString();
        await pool.query('UPDATE users SET premium = TRUE, premium_until = $1 WHERE id = $2', [premiumUntil, user_id]);
        return json(res, 200, { success: true });
    }

    json(res, 404, { success: false, error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
    server.listen(PORT, () => console.log(`[Ghost API v2] Port ${PORT}`));
}).catch(e => { console.error(e); process.exit(1); });
