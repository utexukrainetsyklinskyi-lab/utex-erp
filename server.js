import express from 'express';
import cookieSession from 'cookie-session';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './src/auth.js';
import { router } from './src/routes.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random value with at least 32 characters.');
}

app.disable('x-powered-by');
app.set('views', path.join(root, 'views'));
app.set('view engine', 'ejs');
app.use(helmet());
app.use(cookieSession({
  name: 'utex_session',
  keys: [sessionSecret || 'local-development-only-change-before-deploying-utex-erp'],
  maxAge: 8 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction && process.env.COOKIE_SECURE === '1',
}));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => { res.locals.query = req.query; next(); });


app.use('/assets', express.static(path.join(root, 'public'), { maxAge: isProduction ? '1d' : 0 })); app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use(loadUser);
app.use(router);
app.use((_req, res) => res.status(404).send('Сторінку не знайдено.'));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).send('Внутрішня помилка сервера. Перевірте журнал застосунку.');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`UTEX ERP запущено: http://127.0.0.1:${port}`);
});
