import { Router } from 'express';
import { db } from './database.js';
import {
  createCsrfToken, encodePassword, ensureCsrf, loginUser, requireAdmin, requireAuth, requireCsrf,
} from './auth.js';

export const router = Router();
const today = () => new Date().toISOString().slice(0, 10);
const localDateTimeInput = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const checked = value => value === 'on' || value === '1' || value === 'true' ? 1 : 0;
const isPositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
function paginate(req, total, pageSize = 50) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const requested = Math.max(1, Math.floor(number(req.query.page) || 1));
  const page = Math.min(requested, pageCount);
  const href = value => {
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(req.query)) {
      if (key !== 'page' && typeof raw === 'string' && raw) params.set(key, raw);
    }
    params.set('page', String(value));
    return `${req.path}?${params.toString()}`;
  };
  return { page, pageSize, pageCount, offset: (page - 1) * pageSize,
    rangeStart: total ? (page - 1) * pageSize + 1 : 0, rangeEnd: Math.min(page * pageSize, total), total,
    prevHref: page > 1 ? href(page - 1) : '', nextHref: page < pageCount ? href(page + 1) : '' };
}

function render(req, res, view, title, data = {}) {
  res.render('layout', { view, title, section: '', user: req.user, today: today(), ...data });
}

function renderError(req, res, status, view, title, data = {}) {
  res.status(status);
  return render(req, res, view, title, data);
}

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

router.get('/login', ensureCsrf, (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Вхід · UTEX ERP', error: '', next: safeNext(req.query.next), csrfToken: req.session.csrf });
});

router.post('/login', ensureCsrf, requireCsrf, (req, res) => {
  const user = loginUser(req.body.username || '', req.body.password || '');
  if (!user) return res.status(401).render('login', {
    title: 'Вхід · UTEX ERP', error: 'Невірний логін або пароль.',
    next: safeNext(req.body.next), csrfToken: req.session.csrf,
  });
  req.session = { userId: user.id, csrf: createCsrfToken() };
  res.redirect(safeNext(req.body.next));
});

router.get('/setup', ensureCsrf, (req, res) => {
  const users = db.prepare('SELECT count(*) AS count FROM auth_user WHERE is_staff = 1 OR is_superuser = 1').get().count;
  if (users > 0) return res.redirect('/login');
  res.render('setup', { title: 'Створити першого користувача · UTEX ERP', error: '', csrfToken: req.session.csrf });
});

router.post('/setup', ensureCsrf, requireCsrf, (req, res) => {
  const users = db.prepare('SELECT count(*) AS count FROM auth_user WHERE is_staff = 1 OR is_superuser = 1').get().count;
  if (users > 0) return res.redirect('/login');
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!/^[\w.@+-]{1,150}$/u.test(username) || password.length < 12) {
    return res.status(400).render('setup', { title: 'Створити першого користувача · UTEX ERP',
      error: 'Логін має бути до 150 символів; пароль — не коротший за 12 символів.', csrfToken: req.session.csrf });
  }
  try {
    const result = db.prepare(`INSERT INTO auth_user
      (password, is_superuser, username, last_name, email, is_staff, is_active, date_joined, first_name)
      VALUES (?, 1, ?, '', '', 1, 1, ?, '')`).run(encodePassword(password), username, new Date().toISOString());
    req.session = { userId: Number(result.lastInsertRowid), csrf: createCsrfToken() };
    res.redirect('/');
  } catch (error) {
    res.status(400).render('setup', { title: 'Створити першого користувача · UTEX ERP',
      error: 'Не вдалося створити користувача. Перевірте логін.', csrfToken: req.session.csrf });
  }
});

router.post('/logout', ensureCsrf, requireAuth, requireCsrf, (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.use(ensureCsrf, requireAuth);

function parseAdminUser(body, passwordRequired) {
  const form = {
    username: String(body.username || '').trim(),
    first_name: String(body.first_name || '').trim(),
    last_name: String(body.last_name || '').trim(),
    email: String(body.email || '').trim(),
    role: body.role === 'admin' ? 'admin' : 'user',
    is_active: checked(body.is_active),
  };
  const password = String(body.password || '');
  let error = '';
  if (!/^[\w.@+-]{1,150}$/u.test(form.username)) error = 'Логін має містити 1–150 символів: літери, цифри, крапку, дефіс, підкреслення або @.';
  else if (form.first_name.length > 150 || form.last_name.length > 150) error = 'Ім’я та прізвище мають бути не довші за 150 символів.';
  else if (form.email.length > 254 || (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(form.email))) error = 'Вкажіть коректну електронну адресу до 254 символів.';
  else if ((passwordRequired || password) && (password.length < 12 || password.length > 256)) error = 'Пароль має містити від 12 до 256 символів.';
  return { form, password, error };
}

function renderAdminUserForm(req, res, { id = null, form, error = '' }) {
  return render(req, res, 'admin-user-form', id ? 'Редагування користувача' : 'Новий користувач', {
    section: 'admin', id, form, error,
  });
}

const adminModelGroups = [
  { title: 'Довідники', models: [
    { title: 'Клієнти', description: 'Контактні дані клієнтів.', table: 'warehouse_client', href: '/directories/clients' },
    { title: 'Номенклатура', description: 'Кабель, напівфабрикати й матеріали.', table: 'warehouse_nomenclature', href: '/directories/products' },
    { title: 'Специфікації', description: 'Склад і норми витрат продукції.', table: 'warehouse_specification', href: '/directories/specifications' },
    { title: 'Шаблони маркування', description: 'Тексти маркування для клієнтів і продукції.', table: 'warehouse_markingtemplate', href: '/directories/markings' },
    { title: 'Виробничі лінії', description: 'Обладнання, доступне для планування.', table: 'warehouse_workcenter', href: '/directories/centers' },
    { title: 'Технологічні маршрути', description: 'Швидкості та прив’язка продукції до ліній.', table: 'warehouse_productrouting', href: '/directories/routes' },
    { title: 'Співробітники', description: 'Оператори, доступні для журналу виконання.', table: 'warehouse_employee', href: '/directories/employees' },
  ] },
  { title: 'Виробництво', models: [
    { title: 'Замовлення', description: 'Клієнтські замовлення та їхні етапи.', table: 'warehouse_order', href: '/orders' },
    { title: 'Виробничі завдання', description: 'Стадії виробництва, терміни й прогрес.', table: 'warehouse_productionplan', href: '/plans' },
    { title: 'Журнал виконання', description: 'Випуск, простої та відхилення.', table: 'warehouse_productionlog', href: '/logs' },
  ] },
  { title: 'Доступ', models: [
    { title: 'Облікові записи', description: 'Користувачі, ролі та доступ до системи.', table: 'auth_user', href: '/admin/users', where: ' WHERE is_staff=1 OR is_superuser=1' },
  ] },
];

router.get('/admin', requireAdmin, (req, res) => {
  const groups = adminModelGroups.map(group => ({ ...group, models: group.models.map(model => ({
    ...model,
    count: db.prepare(`SELECT COUNT(*) AS count FROM ${model.table}${model.where || ''}`).get().count,
  })) }));
  render(req, res, 'admin-index', 'Адміністрування', { section: 'admin', groups });
});

router.get('/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 150);
  const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : 'all';
  const clauses = [], args = [];
  if (q) {
    clauses.push('(username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)');
    args.push(...Array(4).fill(`%${q}%`));
  }
  if (status !== 'all') { clauses.push('is_active = ?'); args.push(status === 'active' ? 1 : 0); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM auth_user ${where}`).get(...args).count;
  const page = paginate(req, total);
  const users = db.prepare(`SELECT id,username,first_name,last_name,email,is_staff,is_superuser,is_active,date_joined,last_login
    FROM auth_user ${where} ORDER BY is_superuser DESC, is_active DESC, username COLLATE NOCASE LIMIT ? OFFSET ?`)
    .all(...args, page.pageSize, page.offset);
  const stats = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN is_superuser=1 AND is_active=1 THEN 1 ELSE 0 END) AS admins
    FROM auth_user WHERE is_staff=1 OR is_superuser=1`).get();
  render(req, res, 'admin-users', 'Адміністрування', { section: 'admin', users, stats, q, status, page });
});

router.get('/admin/users/new', requireAdmin, (req, res) => renderAdminUserForm(req, res, {
  form: { username: '', first_name: '', last_name: '', email: '', role: 'user', is_active: 1 },
}));

router.post('/admin/users/new', requireAdmin, requireCsrf, (req, res) => {
  const { form, password, error } = parseAdminUser(req.body, true);
  if (error) return renderError(req, res, 400, 'admin-user-form', 'Новий користувач', { section: 'admin', id: null, form, error });
  const exists = db.prepare('SELECT 1 FROM auth_user WHERE username = ? COLLATE NOCASE').get(form.username);
  if (exists) return renderError(req, res, 400, 'admin-user-form', 'Новий користувач', {
    section: 'admin', id: null, form, error: 'Користувач із таким логіном уже існує.',
  });
  db.prepare(`INSERT INTO auth_user
    (password,is_superuser,username,last_name,email,is_staff,is_active,date_joined,first_name)
    VALUES (?,?,?,?,?,1,?,?,?)`).run(encodePassword(password), form.role === 'admin' ? 1 : 0,
    form.username, form.last_name, form.email, form.is_active, new Date().toISOString(), form.first_name);
  res.redirect('/admin/users');
});

router.get('/admin/users/:id/edit', requireAdmin, (req, res) => {
  const id = number(req.params.id);
  const row = db.prepare(`SELECT id,username,first_name,last_name,email,is_staff,is_superuser,is_active
    FROM auth_user WHERE id=? AND (is_staff=1 OR is_superuser=1)`).get(id);
  if (!row) return res.status(404).send('Користувача не знайдено.');
  renderAdminUserForm(req, res, { id, form: { ...row, role: row.is_superuser ? 'admin' : 'user' } });
});

router.post('/admin/users/:id/edit', requireAdmin, requireCsrf, (req, res) => {
  const id = number(req.params.id);
  const existing = db.prepare('SELECT id FROM auth_user WHERE id=? AND (is_staff=1 OR is_superuser=1)').get(id);
  if (!existing) return res.status(404).send('Користувача не знайдено.');
  const { form, password, error } = parseAdminUser(req.body, false);
  const renderEditError = message => renderError(req, res, 400, 'admin-user-form', 'Редагування користувача', {
    section: 'admin', id, form, error: message,
  });
  if (error) return renderEditError(error);
  const duplicate = db.prepare('SELECT 1 FROM auth_user WHERE username = ? COLLATE NOCASE AND id != ?').get(form.username, id);
  if (duplicate) return renderEditError('Користувач із таким логіном уже існує.');
  const remainsAdmin = db.prepare(`SELECT COUNT(*) AS count FROM auth_user
    WHERE id != ? AND is_superuser=1 AND is_active=1`).get(id).count > 0;
  if ((!form.is_active || form.role !== 'admin') && !remainsAdmin) {
    return renderEditError('Не можна вимкнути або знизити роль останнього активного адміністратора.');
  }
  const values = [form.role === 'admin' ? 1 : 0, form.username, form.last_name, form.email,
    form.is_active, form.first_name, id];
  if (password) {
    db.prepare(`UPDATE auth_user SET is_superuser=?,username=?,last_name=?,email=?,is_active=?,first_name=?,password=? WHERE id=?`)
      .run(values[0], values[1], values[2], values[3], values[4], values[5], encodePassword(password), id);
  } else {
    db.prepare(`UPDATE auth_user SET is_superuser=?,username=?,last_name=?,email=?,is_active=?,first_name=? WHERE id=?`)
      .run(...values);
  }
  if (id === req.user.id && !form.is_active) req.session = null;
  res.redirect('/admin/users');
});

router.get('/', (req, res) => {
  const activeCount = db.prepare("SELECT count(*) AS n FROM warehouse_productionplan WHERE status != 'completed'").get().n;
  const progressCount = db.prepare("SELECT count(*) AS n FROM warehouse_productionplan WHERE status = 'in_progress'").get().n;
  const overdueCount = db.prepare("SELECT count(*) AS n FROM warehouse_order WHERE status != 'done' AND deadline < ?").get(today()).n;
  const todayLogs = db.prepare("SELECT count(*) AS n FROM warehouse_productionlog WHERE date(date_created) = date('now','localtime')").get().n;
  const unscheduledCount = db.prepare("SELECT count(*) AS n FROM warehouse_productionplan WHERE status != 'completed' AND (planned_start IS NULL OR planned_end IS NULL)").get().n;
  const centers = db.prepare(`SELECT c.id, c.code, c.name,
    sum(CASE WHEN p.status != 'completed' THEN 1 ELSE 0 END) AS open_count,
    coalesce(sum(CASE WHEN p.status != 'completed' THEN p.duration_hours ELSE 0 END), 0) AS remaining_hours
    FROM warehouse_workcenter c LEFT JOIN warehouse_productionplan p ON p.work_center_id = c.id
    WHERE c.is_active = 1 GROUP BY c.id ORDER BY c.code`).all();
  const recentLogs = db.prepare(`SELECT l.*, e.first_name, e.last_name, p.product_id, n.name AS product_name, n.unit
    FROM warehouse_productionlog l LEFT JOIN warehouse_employee e ON e.id=l.operator_id
    LEFT JOIN warehouse_productionplan p ON p.id=l.production_plan_id LEFT JOIN warehouse_nomenclature n ON n.id=p.product_id
    ORDER BY l.date_created DESC, l.id DESC LIMIT 4`).all();
  const focusPlans = db.prepare(`SELECT p.*, o.order_number, o.deadline, n.name AS product_name, n.unit,
    n.structure_sku,n.fiber_count,n.item_type,
    c.name AS center_name, coalesce(sum(l.quantity_produced),0) AS produced
    FROM warehouse_productionplan p JOIN warehouse_order o ON o.id=p.order_id
    JOIN warehouse_nomenclature n ON n.id=p.product_id LEFT JOIN warehouse_workcenter c ON c.id=p.work_center_id
    LEFT JOIN warehouse_productionlog l ON l.production_plan_id=p.id
    WHERE p.status != 'completed' GROUP BY p.id ORDER BY o.deadline, p.id LIMIT 6`).all();
  render(req, res, 'dashboard', 'Огляд виробництва', { section: 'dashboard', activeCount, progressCount,
    overdueCount, todayLogs, unscheduledCount, centers, recentLogs, focusPlans });
});

router.get('/orders', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = req.query.status || '';
  const client = /^\d+$/.test(String(req.query.client || '')) ? String(req.query.client) : '';
  const fiberType = String(req.query.fiber_type || '');
  const clauses = [], args = [];
  if (q) { clauses.push('(o.order_number LIKE ? OR c.name LIKE ? OR n.name LIKE ? OR o.fiber_type LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  if (['new', 'in_work', 'done'].includes(status)) { clauses.push('o.status = ?'); args.push(status); }
  if (client) { clauses.push('o.client_id = ?'); args.push(Number(client)); }
  if (fiberType) { clauses.push('o.fiber_type = ?'); args.push(fiberType); }
  if (req.query.overdue === '1') { clauses.push("o.status != 'done' AND o.deadline < ?"); args.push(today()); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(DISTINCT o.id) AS count FROM warehouse_order o
    JOIN warehouse_client c ON c.id=o.client_id JOIN warehouse_nomenclature n ON n.id=o.product_id ${where}`).get(...args).count;
  const page = paginate(req, total);
  const orders = db.prepare(`SELECT o.*, c.name AS client_name, n.name AS product_name,
      count(p.id) AS total_stages, sum(CASE WHEN p.status='completed' THEN 1 ELSE 0 END) AS done_stages
    FROM warehouse_order o JOIN warehouse_client c ON c.id=o.client_id
    JOIN warehouse_nomenclature n ON n.id=o.product_id LEFT JOIN warehouse_productionplan p ON p.order_id=o.id
    ${where} GROUP BY o.id ORDER BY o.deadline, o.id DESC LIMIT ? OFFSET ?`).all(...args, page.pageSize, page.offset);
  const clients = db.prepare('SELECT id,name FROM warehouse_client ORDER BY name').all();
  const fiberTypes = db.prepare("SELECT DISTINCT fiber_type AS value FROM warehouse_order WHERE fiber_type!='' ORDER BY fiber_type").all();
  render(req, res, 'orders', 'Замовлення', { section: 'orders', orders, q, status, client, fiberType, clients, fiberTypes, page });
});

function nomenclatureCycle(productId) {
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const children = db.prepare(`SELECT s.ingredient_id FROM warehouse_specification s
      JOIN warehouse_nomenclature n ON n.id=s.ingredient_id
      WHERE s.product_id=? AND n.item_type IN ('product','half_product')`).all(id);
    for (const row of children) if (visit(row.ingredient_id)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return visit(Number(productId));
}

function scheduleOrderPlans(deadline, tree) {
  const endOfDeadline = new Date(`${deadline}T23:59:00`);
  const earliestStart = new Date();
  if (Number.isNaN(endOfDeadline.getTime()) || endOfDeadline <= earliestStart) {
    throw Object.assign(new Error('Термін замовлення має бути в майбутньому для автоматичного планування.'), { code: 'AUTOPLAN_UNAVAILABLE' });
  }

  const reservations = db.prepare(`SELECT id,work_center_id,planned_start,planned_end FROM warehouse_productionplan
    WHERE work_center_id IS NOT NULL AND planned_start IS NOT NULL AND planned_end IS NOT NULL`).all()
    .map(row => ({ id: row.id, centerId: row.work_center_id, start: new Date(row.planned_start), end: new Date(row.planned_end) }));

  const findLatestSlot = (plan, latestEnd) => {
    if (!plan.work_center_id || !(plan.duration_hours > 0)) {
      throw Object.assign(new Error(`Для етапу «${plan.product_name}» не налаштовано виробничу лінію або швидкість.`), { code: 'AUTOPLAN_UNAVAILABLE' });
    }
    let endMs = latestEnd.getTime();
    const durationMs = plan.duration_hours * 60 * 60 * 1000;
    while (true) {
      const startMs = endMs - durationMs;
      if (startMs < earliestStart.getTime()) {
        throw Object.assign(new Error(`До терміну немає вільного часу на лінії ${plan.center_code || ''} для етапу «${plan.product_name}». Замовлення не створено.`), { code: 'AUTOPLAN_UNAVAILABLE' });
      }
      const conflict = reservations
        .filter(item => item.centerId === plan.work_center_id && item.start < new Date(endMs) && item.end > new Date(startMs))
        .sort((a, b) => b.start - a.start)[0];
      if (!conflict) {
        const slot = { start: new Date(startMs), end: new Date(endMs) };
        reservations.push({ centerId: plan.work_center_id, ...slot });
        return slot;
      }
      endMs = conflict.start.getTime();
    }
  };

  const planById = db.prepare(`SELECT p.*,n.name AS product_name,c.code AS center_code
    FROM warehouse_productionplan p JOIN warehouse_nomenclature n ON n.id=p.product_id
    LEFT JOIN warehouse_workcenter c ON c.id=p.work_center_id WHERE p.id=?`);
  const updatePlan = db.prepare('UPDATE warehouse_productionplan SET planned_start=?,planned_end=? WHERE id=?');
  const placeNode = (node, latestEnd) => {
    let nodeStart = latestEnd;
    for (const id of node.planIds) {
      const plan = planById.get(id);
      const slot = findLatestSlot(plan, latestEnd);
      updatePlan.run(slot.start.toISOString(), slot.end.toISOString(), id);
      if (slot.start < nodeStart) nodeStart = slot.start;
    }
    for (const child of node.children) placeNode(child, nodeStart);
  };

  placeNode(tree, endOfDeadline);
}

const createOrderAndPlans = db.transaction(order => {
  const result = db.prepare(`INSERT INTO warehouse_order
    (order_number, client_id, product_id, fiber_type, quantity, length_per_drum, status, deadline, skip_fiber_painting)
    VALUES (@order_number,@client_id,@product_id,@fiber_type,@quantity,@length_per_drum,'new',@deadline,@skip_fiber_painting)`).run({
      order_number: order.order_number, client_id: order.client_id, product_id: order.product_id,
      fiber_type: order.fiber_type, quantity: order.quantity, length_per_drum: order.length_per_drum,
      deadline: order.deadline, skip_fiber_painting: order.skip_fiber_painting,
    });
  const orderId = Number(result.lastInsertRowid);
  const makePlan = (productId, quantity, path = new Set()) => {
    if (path.has(productId)) throw new Error('Цикл у специфікації');
    const nextPath = new Set(path).add(productId);
    const product = db.prepare('SELECT * FROM warehouse_nomenclature WHERE id=?').get(productId);
    const routes = db.prepare(`SELECT r.*, c.code AS center_code, c.name AS center_name FROM warehouse_productrouting r
      JOIN warehouse_workcenter c ON c.id=r.work_center_id WHERE r.product_id=? AND r.is_primary=1`).all(productId);
    const productionRoutes = order.skip_fiber_painting
      ? routes.filter(route => !/фарб/i.test(route.center_name))
      : routes;
    const create = db.prepare(`INSERT INTO warehouse_productionplan
      (order_id, product_id, fiber_type, quantity_needed, work_center_id, duration_hours,
       planned_start, planned_end, stage_name, status) VALUES (?,?,?,?,?,?,NULL,NULL,?,'queued')`);
    const planIds = [];
    if (routes.length) {
      for (const route of productionRoutes) {
        const duration = route.speed_m_per_min > 0 ? quantity * 1000 / route.speed_m_per_min / 60 : 0;
        const inserted = create.run(orderId, productId, order.fiber_type, quantity, route.work_center_id, duration,
          route.ketr || `Виробництво ${product.name} на ${route.center_code}`);
        planIds.push(Number(inserted.lastInsertRowid));
      }
    } else {
      const inserted = create.run(orderId, productId, order.fiber_type, quantity, null, 0, `Етап: ${product.name} (маршрут не задано)`);
      planIds.push(Number(inserted.lastInsertRowid));
    }
    const specs = db.prepare(`SELECT s.ingredient_id, s.quantity, n.item_type FROM warehouse_specification s
      JOIN warehouse_nomenclature n ON n.id=s.ingredient_id WHERE s.product_id=?`).all(productId);
    const children = [];
    for (const spec of specs) if (['half_product', 'product'].includes(spec.item_type)) {
      children.push(makePlan(spec.ingredient_id, quantity * spec.quantity, nextPath));
    }
    return { productId, planIds, children };
  };
  const tree = makePlan(Number(order.product_id), Number(order.quantity));
  if (order.auto_plan) scheduleOrderPlans(order.deadline, tree);
  return orderId;
});

router.get('/orders/new', (req, res) => {
  render(req, res, 'order-form', 'Нове замовлення', {
    section: 'orders', clients: db.prepare('SELECT id,name FROM warehouse_client ORDER BY name').all(),
    products: db.prepare("SELECT id,name,fiber_count FROM warehouse_nomenclature WHERE item_type='product' ORDER BY name").all(),
    form: { auto_plan: 'on' }, error: '',
  });
});

router.post('/orders/new', requireCsrf, (req, res) => {
  const form = { ...req.body, auto_plan: req.body.auto_plan === 'on' ? 'on' : '' };
  const clients = db.prepare('SELECT id,name FROM warehouse_client ORDER BY name').all();
  const products = db.prepare("SELECT id,name,fiber_count FROM warehouse_nomenclature WHERE item_type='product' ORDER BY name").all();
  const error = !form.order_number?.trim() ? 'Вкажіть номер замовлення.'
    : !form.client_id || !form.product_id ? 'Оберіть клієнта та продукцію.'
    : !isPositive(form.quantity) ? 'Кількість має бути більшою за нуль.'
    : !form.deadline ? 'Вкажіть термін виконання.'
    : (form.length_per_drum && (!isPositive(form.length_per_drum) || number(form.length_per_drum) > number(form.quantity))) ? 'Довжина барабана має бути додатною та не перевищувати замовлення.'
    : nomenclatureCycle(form.product_id) ? 'Специфікація містить цикл. Виправте довідник перед створенням замовлення.' : '';
  if (error) return renderError(req, res, 400, 'order-form', 'Нове замовлення', { section: 'orders', clients, products, form, error });
  try {
    const id = createOrderAndPlans({ order_number: form.order_number.trim(), client_id: number(form.client_id),
      product_id: number(form.product_id), fiber_type: form.fiber_type || '', quantity: number(form.quantity),
      length_per_drum: form.length_per_drum ? number(form.length_per_drum) : null, deadline: form.deadline,
      skip_fiber_painting: checked(form.skip_fiber_painting), auto_plan: checked(form.auto_plan) });
    res.redirect(`/orders/${id}`);
  } catch (e) {
    return renderError(req, res, 400, 'order-form', 'Нове замовлення', { section: 'orders', clients, products, form,
      error: e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Таке замовлення вже існує.'
        : e.code === 'AUTOPLAN_UNAVAILABLE' ? e.message
          : 'Не вдалося зберегти замовлення; перевірте вибрані довідники.' });
  }
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare(`SELECT o.*, c.name AS client_name, n.name AS product_name, n.unit
    FROM warehouse_order o JOIN warehouse_client c ON c.id=o.client_id
    JOIN warehouse_nomenclature n ON n.id=o.product_id WHERE o.id=?`).get(req.params.id);
  if (!order) return res.sendStatus(404);
  const plans = db.prepare(`SELECT p.*, o.order_number,o.deadline,n.name AS product_name,n.unit,
    n.structure_sku,n.fiber_count,n.item_type,c.code AS center_code,
    coalesce(sum(l.quantity_produced),0) AS produced FROM warehouse_productionplan p
    JOIN warehouse_nomenclature n ON n.id=p.product_id LEFT JOIN warehouse_workcenter c ON c.id=p.work_center_id
    LEFT JOIN warehouse_productionlog l ON l.production_plan_id=p.id WHERE p.order_id=? GROUP BY p.id ORDER BY p.id`).all(order.id);
  render(req, res, 'order-detail', `Замовлення ${order.order_number}`, { section: 'orders', order, plans });
});

router.post('/orders/:id/status', requireCsrf, (req, res) => {
  if (!['new', 'in_work', 'done'].includes(req.body.status)) return res.sendStatus(400);
  const result = db.prepare('UPDATE warehouse_order SET status=? WHERE id=?').run(req.body.status, req.params.id);
  if (!result.changes) return res.sendStatus(404);
  res.redirect(303, `/orders/${req.params.id}?saved=1`);
});

router.post('/admin/orders/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  const result = db.prepare('DELETE FROM warehouse_order WHERE id=?').run(number(req.params.id));
  if (!result.changes) return res.sendStatus(404);
  res.redirect('/orders');
});

router.post('/admin/plans/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  const result = db.prepare('DELETE FROM warehouse_productionplan WHERE id=?').run(number(req.params.id));
  if (!result.changes) return res.sendStatus(404);
  res.redirect('/plans');
});

router.post('/admin/logs/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  const log = db.prepare('SELECT production_plan_id FROM warehouse_productionlog WHERE id=?').get(number(req.params.id));
  if (!log) return res.sendStatus(404);
  db.prepare('DELETE FROM warehouse_productionlog WHERE id=?').run(number(req.params.id));
  if (log.production_plan_id) updatePlanStatus(log.production_plan_id);
  res.redirect('/logs');
});

router.get('/plans', (req, res) => {
  const q = (req.query.q || '').trim(), status = req.query.status || 'active', center = req.query.center || '';
  const fiberType = String(req.query.fiber_type || '');
  const itemType = ['product','half_product','material'].includes(req.query.item_type) ? req.query.item_type : '';
  const clauses = [], args = [];
  if (q) { clauses.push('(o.order_number LIKE ? OR n.name LIKE ? OR p.stage_name LIKE ? OR p.fiber_type LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  if (status === 'active') clauses.push("p.status != 'completed'");
  else if (status === 'queued') clauses.push("p.status='queued' AND p.planned_end IS NULL");
  else if (status === 'scheduled') clauses.push("p.status='queued' AND p.planned_end IS NOT NULL");
  else if (['in_progress', 'completed'].includes(status)) { clauses.push('p.status=?'); args.push(status); }
  if (/^\d+$/.test(center)) { clauses.push('p.work_center_id=?'); args.push(Number(center)); }
  if (fiberType) { clauses.push('p.fiber_type=?'); args.push(fiberType); }
  if (itemType) { clauses.push('n.item_type=?'); args.push(itemType); }
  if (req.query.unscheduled === '1') clauses.push('(p.planned_start IS NULL OR p.planned_end IS NULL)');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(DISTINCT p.id) AS count FROM warehouse_productionplan p
    JOIN warehouse_order o ON o.id=p.order_id JOIN warehouse_nomenclature n ON n.id=p.product_id
    LEFT JOIN warehouse_workcenter c ON c.id=p.work_center_id ${where}`).get(...args).count;
  const page = paginate(req, total);
  const plans = db.prepare(`SELECT p.*, o.order_number, o.deadline, n.name AS product_name, n.unit,
    n.structure_sku,n.fiber_count,n.item_type,c.code AS center_code,
    coalesce(sum(l.quantity_produced),0) AS produced FROM warehouse_productionplan p
    JOIN warehouse_order o ON o.id=p.order_id JOIN warehouse_nomenclature n ON n.id=p.product_id
    LEFT JOIN warehouse_workcenter c ON c.id=p.work_center_id LEFT JOIN warehouse_productionlog l ON l.production_plan_id=p.id
    ${where} GROUP BY p.id ORDER BY p.planned_start IS NULL, p.planned_start, p.id LIMIT ? OFFSET ?`).all(...args, page.pageSize, page.offset);
  const centers = db.prepare('SELECT id,code,name FROM warehouse_workcenter ORDER BY code').all();
  const fiberTypes = db.prepare("SELECT DISTINCT fiber_type AS value FROM warehouse_productionplan WHERE fiber_type!='' ORDER BY fiber_type").all();
  render(req, res, 'plans', 'Виробничий план', { section: 'plans', plans, centers, fiberTypes, q, status, center, fiberType, itemType, page });
});

router.get('/plans/new', (req, res) => {
  render(req, res, 'stage-form', 'Новий виробничий етап', { section: 'plans', form: {}, error: '',
    orders: db.prepare('SELECT id,order_number FROM warehouse_order ORDER BY id DESC').all(),
    products: db.prepare('SELECT id,name FROM warehouse_nomenclature ORDER BY name').all(),
    centers: db.prepare('SELECT id,code,name FROM warehouse_workcenter WHERE is_active=1 ORDER BY code').all() });
});

router.post('/plans/new', requireCsrf, (req, res) => {
  const f = req.body;
  const route = db.prepare('SELECT speed_m_per_min FROM warehouse_productrouting WHERE product_id=? AND work_center_id=?').get(f.product_id, f.work_center_id);
  if (!isPositive(f.quantity_needed) || !f.order_id || !f.product_id || !f.work_center_id || !route) {
    return renderError(req, res, 400, 'stage-form', 'Новий виробничий етап', { section: 'plans', form: f,
      error: !isPositive(f.quantity_needed) ? 'Вкажіть додатну кількість.' : 'Оберіть замовлення, продукт і лінію з налаштованим маршрутом.',
      orders: db.prepare('SELECT id,order_number FROM warehouse_order ORDER BY id DESC').all(),
      products: db.prepare('SELECT id,name FROM warehouse_nomenclature ORDER BY name').all(),
      centers: db.prepare('SELECT id,code,name FROM warehouse_workcenter WHERE is_active=1 ORDER BY code').all() });
  }
  const duration = route.speed_m_per_min > 0 ? number(f.quantity_needed) * 1000 / route.speed_m_per_min / 60 : 0;
  const result = db.prepare(`INSERT INTO warehouse_productionplan
    (order_id,product_id,fiber_type,quantity_needed,work_center_id,duration_hours,stage_name,status)
    SELECT ?,?,?,?, ?, ?, ?, 'queued'`).run(f.order_id, f.product_id,
      db.prepare('SELECT fiber_type FROM warehouse_order WHERE id=?').get(f.order_id)?.fiber_type || '',
      number(f.quantity_needed), f.work_center_id, duration, (f.stage_name || '').trim());
  res.redirect(`/plans/${result.lastInsertRowid}`);
});

router.get('/plans/:id', (req, res) => {
  const plan = db.prepare(`SELECT p.*, o.order_number, o.deadline, o.length_per_drum, n.name AS product_name,
    n.unit, c.code AS center_code, c.name AS center_name, coalesce(sum(l.quantity_produced),0) AS produced
    FROM warehouse_productionplan p JOIN warehouse_order o ON o.id=p.order_id
    JOIN warehouse_nomenclature n ON n.id=p.product_id LEFT JOIN warehouse_workcenter c ON c.id=p.work_center_id
    LEFT JOIN warehouse_productionlog l ON l.production_plan_id=p.id WHERE p.id=? GROUP BY p.id`).get(req.params.id);
  if (!plan) return res.sendStatus(404);
  const logs = db.prepare(`SELECT l.*, e.first_name,e.last_name FROM warehouse_productionlog l
    JOIN warehouse_employee e ON e.id=l.operator_id WHERE l.production_plan_id=? ORDER BY l.date_created DESC`).all(plan.id);
  const routes = db.prepare(`SELECT r.work_center_id,c.code,c.name,r.speed_m_per_min FROM warehouse_productrouting r
    JOIN warehouse_workcenter c ON c.id=r.work_center_id WHERE r.product_id=? AND c.is_active=1`).all(plan.product_id);
  render(req, res, 'plan-detail', `Завдання №${plan.id}`, { section: 'plans', plan, logs, routes });
});

router.get('/logs', (req, res) => {
  const q = (req.query.q || '').trim(), kind = req.query.kind || '';
  const productionType = String(req.query.production_type || '');
  const operator = /^\d+$/.test(String(req.query.operator || '')) ? String(req.query.operator) : '';
  const deviation = ['0','1'].includes(String(req.query.deviation || '')) ? String(req.query.deviation) : '';
  const downtime = ['0','1'].includes(String(req.query.downtime || '')) ? String(req.query.downtime) : '';
  const clauses = [], args = [];
  if (q) { clauses.push('(e.last_name LIKE ? OR e.first_name LIKE ? OR o.order_number LIKE ? OR n.name LIKE ? OR l.deviation_comment LIKE ?)');
    args.push(...Array(5).fill(`%${q}%`)); }
  if (kind === 'downtime') clauses.push('l.has_downtime=1');
  if (kind === 'deviation') clauses.push('l.has_deviation=1');
  if (productionType) { clauses.push('l.production_type=?'); args.push(productionType); }
  if (operator) { clauses.push('l.operator_id=?'); args.push(Number(operator)); }
  if (deviation) { clauses.push('l.has_deviation=?'); args.push(Number(deviation)); }
  if (downtime) { clauses.push('l.has_downtime=?'); args.push(Number(downtime)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(DISTINCT l.id) AS count FROM warehouse_productionlog l
    JOIN warehouse_employee e ON e.id=l.operator_id LEFT JOIN warehouse_productionplan p ON p.id=l.production_plan_id
    LEFT JOIN warehouse_order o ON o.id=p.order_id LEFT JOIN warehouse_nomenclature n ON n.id=p.product_id ${where}`).get(...args).count;
  const page = paginate(req, total);
  const logs = db.prepare(`SELECT l.*, e.first_name,e.last_name,o.order_number,n.name AS product_name,n.unit
    FROM warehouse_productionlog l JOIN warehouse_employee e ON e.id=l.operator_id
    LEFT JOIN warehouse_productionplan p ON p.id=l.production_plan_id
    LEFT JOIN warehouse_order o ON o.id=p.order_id LEFT JOIN warehouse_nomenclature n ON n.id=p.product_id
    ${where} ORDER BY l.date_created DESC LIMIT ? OFFSET ?`).all(...args, page.pageSize, page.offset);
  const productionTypes = db.prepare("SELECT DISTINCT production_type AS value FROM warehouse_productionlog WHERE production_type!='' ORDER BY production_type").all();
  const employees = db.prepare('SELECT id,first_name,last_name FROM warehouse_employee ORDER BY last_name,first_name').all();
  render(req, res, 'logs', 'Журнал виконання', { section: 'logs', logs, q, kind, productionType, operator, deviation, downtime, productionTypes, employees, page });
});

function executionFormData() {
  return { plans: db.prepare(`SELECT p.id,p.quantity_needed,n.name AS product_name,o.order_number
    FROM warehouse_productionplan p JOIN warehouse_nomenclature n ON n.id=p.product_id
    JOIN warehouse_order o ON o.id=p.order_id ORDER BY p.id DESC`).all(),
    employees: db.prepare('SELECT id,first_name,last_name FROM warehouse_employee WHERE is_active=1 ORDER BY last_name').all() };
}

router.get('/logs/new', (req, res) => render(req, res, 'log-form', 'Записати виконання', {
  section: 'logs', form: { date_created: localDateTimeInput(), production_plan_id: req.query.plan || '',
    quantity_produced: req.query.quantity || '0' }, error: '', ...executionFormData(),
}));
router.post('/logs/new', requireCsrf, (req, res) => {
  const f = req.body;
  const performedAt = f.date_created ? new Date(f.date_created) : null;
  const validPerformedAt = performedAt && !Number.isNaN(performedAt.getTime());
  let dependencyError = '';
  if (f.production_plan_id && isPositive(f.quantity_produced)) {
    const plan = db.prepare('SELECT id,order_id,product_id FROM warehouse_productionplan WHERE id=?').get(number(f.production_plan_id));
    if (!plan) dependencyError = 'Виробниче завдання не знайдено.';
    else {
      const blockedBy = getPlanDependencies(plan).find(dep => dep.status !== 'completed');
      if (blockedBy) dependencyError = `Не можна записати випуск: спочатку повністю завершіть етап «${blockedBy.product_name}».`;
    }
  }
  const error = dependencyError || (!validPerformedAt ? 'Вкажіть коректні дату та час виконання.'
    : !f.operator_id ? 'Оберіть оператора.'
    : (!isPositive(f.quantity_produced) && f.has_downtime !== 'on' && f.has_deviation !== 'on') ? 'Вкажіть випуск або зафіксуйте простій / відхилення.'
    : (f.has_deviation === 'on' && !f.deviation_comment?.trim()) ? 'Опишіть відхилення.'
    : (f.has_downtime === 'on' && !f.downtime_reason?.trim()) ? 'Вкажіть причину простою.'
    : (number(f.downtime_minutes) > 59) ? 'Хвилини простою мають бути від 0 до 59.' : '');
  if (error) return renderError(req, res, 400, 'log-form', 'Записати виконання', { section: 'logs', form: f, error, ...executionFormData() });
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO warehouse_productionlog
      (production_plan_id,quantity_produced,date_created,production_type,operator_id,has_deviation,deviation_comment,
       has_downtime,downtime_hours,downtime_minutes,downtime_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.production_plan_id || null, Math.max(0, number(f.quantity_produced)), performedAt.toISOString(),
        f.production_type || 'Серійна', f.operator_id, checked(f.has_deviation), f.has_deviation === 'on' ? f.deviation_comment.trim() : '',
        checked(f.has_downtime), f.has_downtime === 'on' ? Math.max(0, number(f.downtime_hours)) : 0,
        f.has_downtime === 'on' ? Math.max(0, number(f.downtime_minutes)) : 0, f.has_downtime === 'on' ? f.downtime_reason.trim() : '');
    if (f.production_plan_id) updatePlanStatus(Number(f.production_plan_id));
  });
  try { insert(); res.redirect(f.production_plan_id ? `/plans/${f.production_plan_id}` : '/logs'); }
  catch { return renderError(req, res, 400, 'log-form', 'Записати виконання', { section: 'logs', form: f, error: 'Не вдалося зберегти запис.', ...executionFormData() }); }
});

function updatePlanStatus(id) {
  const plan = db.prepare('SELECT quantity_needed FROM warehouse_productionplan WHERE id=?').get(id);
  if (!plan) return;
  const total = db.prepare('SELECT coalesce(sum(quantity_produced),0) AS total FROM warehouse_productionlog WHERE production_plan_id=?').get(id).total;
  const status = total <= 0 ? 'queued' : total >= plan.quantity_needed ? 'completed' : 'in_progress';
  db.prepare('UPDATE warehouse_productionplan SET status=? WHERE id=?').run(status, id);
}

const directories = {
  clients: { title: 'Клієнти', table: 'warehouse_client', fields: [
    ['name','Назва','text',true], ['phone','Телефон','text',false], ['email','Email','email',false]] },
  products: { title: 'Номенклатура', table: 'warehouse_nomenclature', fields: [
    ['sku','Артикул','text',false], ['name','Назва','text',true], ['item_type','Тип','select',true,
      [['product','Готова продукція'],['half_product','Напівфабрикат'],['material','Матеріал']]],
    ['unit','Одиниця виміру','text',true], ['structure_sku','Артикул конструкції','text',false], ['fiber_count','Кількість волокон','number',false]] },
  centers: { title: 'Виробничі лінії', table: 'warehouse_workcenter', fields: [
    ['code','Код лінії','text',true], ['name','Назва','text',true], ['is_active','Активна','checkbox',false]] },
  employees: { title: 'Співробітники', table: 'warehouse_employee', fields: [
    ['last_name','Прізвище','text',true], ['first_name','Ім’я','text',true], ['position','Посада','text',true], ['is_active','Працює','checkbox',false]] },
  routes: { title: 'Технологічні маршрути', table: 'warehouse_productrouting', fields: [
    ['product_id','Продукт','select',true,'products'], ['work_center_id','Лінія','select',true,'centers'],
    ['speed_m_per_min','Швидкість, м/хв','number',false], ['is_primary','Основний маршрут','checkbox',false], ['ketr','КЕТР','text',false]] },
  specifications: { title: 'Специфікації', table: 'warehouse_specification', fields: [
    ['product_id','Готовий продукт / напівфабрикат','select',true,'products'],
    ['ingredient_id','Компонент','select',true,'products'], ['quantity','Норма витрати','number',true]] },
  markings: { title: 'Шаблони маркування', table: 'warehouse_markingtemplate', fields: [
    ['template_name','Назва шаблону','text',true], ['client_id','Клієнт','select',true,'clients'],
    ['product_id','Продукт','select',true,'products'], ['text','Текст маркування','textarea',true]] },
};

function directoryOptions(key) {
  if (key === 'clients') return db.prepare('SELECT id,name AS label FROM warehouse_client ORDER BY name').all();
  if (key === 'centers') return db.prepare('SELECT id,code || " · " || name AS label FROM warehouse_workcenter ORDER BY code').all();
  if (key === 'products') return db.prepare('SELECT id,sku || " · " || name AS label FROM warehouse_nomenclature ORDER BY name').all();
  return [];
}

const directoryListConfigs = {
  clients: { from: 'warehouse_client', select: 'id,name,phone,email', order: 'name COLLATE NOCASE', search: ['name','phone','email'], filters: [] },
  products: { from: 'warehouse_nomenclature', select: 'id,sku,name,item_type,unit,structure_sku,fiber_count', order: 'name COLLATE NOCASE', search: ['sku','name','structure_sku'], filters: [
    { name: 'item_type', label: 'Тип', sql: 'item_type', choices: [['product','Кабель'],['half_product','Напівфабрикат'],['material','Матеріал']] },
    { name: 'unit', label: 'Одиниця', sql: 'unit', dynamic: 'unit' },
  ] },
  centers: { from: 'warehouse_workcenter', select: 'id,code,name,is_active', order: 'code COLLATE NOCASE', search: ['code','name'], filters: [
    { name: 'is_active', label: 'Статус', sql: 'is_active', choices: [['1','Активні'],['0','Вимкнені']] },
  ] },
  employees: { from: 'warehouse_employee', select: 'id,last_name,first_name,position,is_active', order: 'last_name COLLATE NOCASE,first_name COLLATE NOCASE', search: ['last_name','first_name','position'], filters: [
    { name: 'is_active', label: 'Статус', sql: 'is_active', choices: [['1','Працюють'],['0','Не працюють']] },
    { name: 'position', label: 'Посада', sql: 'position', dynamic: true },
  ] },
  routes: { from: 'warehouse_productrouting r JOIN warehouse_nomenclature n ON n.id=r.product_id JOIN warehouse_workcenter c ON c.id=r.work_center_id',
    select: 'r.id,n.name AS product_name,c.code AS center_code,r.speed_m_per_min,r.is_primary,r.ketr', order: 'n.name COLLATE NOCASE,c.code',
    search: ['n.name','r.ketr'], filters: [
      { name: 'work_center_id', label: 'Лінія', sql: 'r.work_center_id', dynamic: 'centers' },
      { name: 'is_primary', label: 'Маршрут', sql: 'r.is_primary', choices: [['1','Основні'],['0','Додаткові']] },
    ] },
  specifications: { from: 'warehouse_specification s JOIN warehouse_nomenclature p ON p.id=s.product_id JOIN warehouse_nomenclature i ON i.id=s.ingredient_id',
    select: 's.id,p.name AS product_name,i.name AS ingredient_name,s.quantity', order: 'p.name COLLATE NOCASE,i.name COLLATE NOCASE',
    search: ['p.name','i.name'], filters: [
      { name: 'product_id', label: 'Продукт', sql: 's.product_id', dynamic: 'products' },
    ] },
  markings: { from: 'warehouse_markingtemplate m JOIN warehouse_client c ON c.id=m.client_id JOIN warehouse_nomenclature n ON n.id=m.product_id',
    select: 'm.id,m.template_name,c.name AS client_name,n.name AS product_name,m.text', order: 'm.template_name COLLATE NOCASE',
    search: ['m.template_name','m.text'], filters: [
      { name: 'client_id', label: 'Клієнт', sql: 'm.client_id', dynamic: 'clients' },
    ] },
};

function directoryRows(key, req) {
  const config = directoryListConfigs[key];
  if (!config) return null;
  const clauses = [], args = [], q = String(req.query.q || '').trim().slice(0, 150);
  if (q) {
    clauses.push(`(${config.search.map(column => `${column} LIKE ?`).join(' OR ')})`);
    args.push(...config.search.map(() => `%${q}%`));
  }
  const filterOptions = {};
  for (const filter of config.filters) {
    let choices = filter.choices || [];
    if (filter.dynamic === 'centers') choices = db.prepare('SELECT id,code || " · " || name AS label FROM warehouse_workcenter ORDER BY code').all().map(row => [String(row.id), row.label]);
    if (filter.dynamic === 'products') choices = db.prepare('SELECT id,name AS label FROM warehouse_nomenclature ORDER BY name').all().map(row => [String(row.id), row.label]);
    if (filter.dynamic === 'clients') choices = db.prepare('SELECT id,name AS label FROM warehouse_client ORDER BY name').all().map(row => [String(row.id), row.label]);
    if (filter.dynamic === 'unit') choices = db.prepare(`SELECT DISTINCT unit AS value FROM ${config.from} WHERE unit!='' ORDER BY unit`).all().map(row => [String(row.value), String(row.value)]);
    if (filter.dynamic === true) choices = db.prepare(`SELECT DISTINCT ${filter.sql} AS value FROM ${config.from} WHERE ${filter.sql}!='' ORDER BY ${filter.sql}`).all().map(row => [String(row.value), String(row.value)]);
    filterOptions[filter.name] = { label: filter.label, choices };
    const value = String(req.query[filter.name] || '');
    if (choices.some(([choice]) => choice === value)) { clauses.push(`${filter.sql}=?`); args.push(value); }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM ${config.from} ${where}`).get(...args).count;
  const page = paginate(req, total);
  const rows = db.prepare(`SELECT ${config.select} FROM ${config.from} ${where} ORDER BY ${config.order} LIMIT ? OFFSET ?`)
    .all(...args, page.pageSize, page.offset);
  return { rows, page, q, filterOptions, selectedFilters: Object.fromEntries(config.filters.map(filter => [filter.name, String(req.query[filter.name] || '')])) };
}

function directoryFieldOptions(fields) {
  const options = {};
  for (const field of fields) if (field[2] === 'select' && typeof field[4] === 'string') options[field[0]] = directoryOptions(field[4]);
  return options;
}

router.get('/directories', (req, res) => render(req, res, 'directories', 'Довідники', { section: 'directories', directories }));
router.get('/directories/:key', (req, res) => {
  const config = directories[req.params.key];
  if (!config) return res.sendStatus(404);
  const listing = directoryRows(req.params.key, req);
  render(req, res, 'records', config.title, { section: 'directories', key: req.params.key, config,
    rows: listing.rows, fields: config.fields, page: listing.page, q: listing.q,
    filterOptions: listing.filterOptions, selectedFilters: listing.selectedFilters });
});
router.get('/directories/:key/new', (req, res) => {
  const config = directories[req.params.key];
  if (!config) return res.sendStatus(404);
  render(req, res, 'record-form', `Додати · ${config.title}`, { section: 'directories', key: req.params.key,
    config, fields: config.fields, form: {}, options: directoryFieldOptions(config.fields), error: '' });
});
router.get('/directories/:key/:id/edit', (req, res) => {
  const config = directories[req.params.key];
  if (!config) return res.sendStatus(404);
  const form = db.prepare(`SELECT * FROM ${config.table} WHERE id=?`).get(req.params.id);
  if (!form) return res.sendStatus(404);
  const specifications = req.params.key === 'products' ? db.prepare(`SELECT s.id,s.ingredient_id,s.quantity,n.sku,n.name,n.unit,n.item_type
    FROM warehouse_specification s JOIN warehouse_nomenclature n ON n.id=s.ingredient_id
    WHERE s.product_id=? ORDER BY n.name`).all(form.id) : [];
  render(req, res, 'record-form', `Редагувати · ${config.title}`, { section: 'directories', key: req.params.key,
    config, fields: config.fields, form, options: directoryFieldOptions(config.fields), specifications,
    ingredientOptions: req.params.key === 'products' ? directoryOptions('products') : [], error: '' });
});

router.post('/directories/products/:id/specifications/new', requireCsrf, (req, res) => {
  const productId = number(req.params.id), ingredientId = number(req.body.ingredient_id), quantity = Number(req.body.quantity);
  const product = db.prepare('SELECT id FROM warehouse_nomenclature WHERE id=?').get(productId);
  const ingredient = db.prepare('SELECT id FROM warehouse_nomenclature WHERE id=?').get(ingredientId);
  if (!product || !ingredient || !isPositive(quantity)) return res.redirect(`/directories/products/${productId}/edit?spec_error=1`);
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO warehouse_specification (product_id,ingredient_id,quantity) VALUES (?,?,?)').run(productId, ingredientId, quantity);
      if (nomenclatureCycle(productId)) throw new Error('Specification cycle');
    })();
    res.redirect(`/directories/products/${productId}/edit`);
  } catch { res.redirect(`/directories/products/${productId}/edit?spec_error=1`); }
});

router.post('/directories/products/:id/specifications/:specificationId/edit', requireCsrf, (req, res) => {
  const productId = number(req.params.id), specificationId = number(req.params.specificationId);
  const ingredientId = number(req.body.ingredient_id), quantity = Number(req.body.quantity);
  const owned = db.prepare('SELECT id FROM warehouse_specification WHERE id=? AND product_id=?').get(specificationId, productId);
  const ingredient = db.prepare('SELECT id FROM warehouse_nomenclature WHERE id=?').get(ingredientId);
  if (!owned || !ingredient || !isPositive(quantity)) return res.redirect(`/directories/products/${productId}/edit?spec_error=1`);
  try {
    db.transaction(() => {
      db.prepare('UPDATE warehouse_specification SET ingredient_id=?,quantity=? WHERE id=? AND product_id=?')
        .run(ingredientId, quantity, specificationId, productId);
      if (nomenclatureCycle(productId)) throw new Error('Specification cycle');
    })();
    res.redirect(`/directories/products/${productId}/edit`);
  } catch { res.redirect(`/directories/products/${productId}/edit?spec_error=1`); }
});

router.post('/directories/products/:id/specifications/:specificationId/delete', requireCsrf, (req, res) => {
  db.prepare('DELETE FROM warehouse_specification WHERE id=? AND product_id=?')
    .run(number(req.params.specificationId), number(req.params.id));
  res.redirect(`/directories/products/${number(req.params.id)}/edit`);
});

function saveDirectory(req, res, edit) {
  const key = req.params.key, config = directories[key];
  if (!config) return res.sendStatus(404);
  const fields = config.fields;
  const params = {}, columns = [];
  for (const [name, label, type, required] of fields) {
    let value = req.body[name];
    if (type === 'checkbox') value = checked(value);
    else if (type === 'number') value = value === '' || value === undefined ? 0 : Number(value);
    else if (typeof value === 'string') value = value.trim();
    if (required && (value === '' || value === null || value === undefined || (type === 'number' && !Number.isFinite(value)))) {
      return renderError(req, res, 400, 'record-form', `${edit ? 'Редагувати' : 'Додати'} · ${config.title}`, { section: 'directories', key,
        config, fields, form: req.body, options: directoryFieldOptions(fields), error: `Заповніть поле «${label}».` });
    }
    if (type === 'number' && (!Number.isFinite(value) || value < 0)) {
      return renderError(req, res, 400, 'record-form', `${edit ? 'Редагувати' : 'Додати'} · ${config.title}`, { section: 'directories', key,
        config, fields, form: req.body, options: directoryFieldOptions(fields), error: `Поле «${label}» має бути невід’ємним числом.` });
    }
    params[name] = value ?? '';
    columns.push(name);
  }
  if (key === 'products' && !params.sku) {
    const last = db.prepare('SELECT id,sku FROM warehouse_nomenclature ORDER BY id DESC LIMIT 1').get();
    const next = last ? (/^\d+$/.test(last.sku) ? Number(last.sku) + 1 : last.id + 1) : 1;
    params.sku = String(next).padStart(6, '0');
  }
  try {
    if (edit) db.prepare(`UPDATE ${config.table} SET ${columns.map(name => `${name}=@${name}`).join(', ')} WHERE id=@id`)
      .run({ ...params, id: Number(req.params.id) });
    else db.prepare(`INSERT INTO ${config.table} (${columns.join(',')}) VALUES (${columns.map(n => `@${n}`).join(',')})`).run(params);
    res.redirect(`/directories/${key}`);
  } catch (error) {
    return renderError(req, res, 400, 'record-form', `${edit ? 'Редагувати' : 'Додати'} · ${config.title}`, { section: 'directories', key,
      config, fields, form: req.body, options: directoryFieldOptions(fields), error: 'Не вдалося зберегти. Перевірте унікальність і зв’язки.' });
  }
}
router.post('/directories/:key/new', requireCsrf, (req, res) => saveDirectory(req, res, false));
router.post('/directories/:key/:id/edit', requireCsrf, (req, res) => saveDirectory(req, res, true));
router.post('/directories/:key/:id/delete', requireCsrf, (req, res) => {
  const config = directories[req.params.key];
  if (!config) return res.sendStatus(404);
  try { db.prepare(`DELETE FROM ${config.table} WHERE id=?`).run(req.params.id); }
  catch { return res.status(409).send('Запис використовується в інших даних і не може бути видалений.'); }
  res.redirect(`/directories/${req.params.key}`);
});

router.get('/gantt', (req, res) => render(req, res, 'gantt', 'Графік ліній', { section: 'gantt' }));
router.get('/api/gantt/data', (req, res) => {
  const groups = db.prepare('SELECT id, code, name FROM warehouse_workcenter WHERE is_active=1 ORDER BY code').all()
    .map(row => ({ id: row.id, content: `${row.name} (${row.code})` }));
  const items = db.prepare(`SELECT p.id,p.planned_start,p.planned_end,p.status,o.order_number,n.name AS product_name,
    n.unit,p.quantity_needed,p.work_center_id,coalesce(sum(l.quantity_produced),0) AS produced
    FROM warehouse_productionplan p JOIN warehouse_order o ON o.id=p.order_id
    JOIN warehouse_nomenclature n ON n.id=p.product_id LEFT JOIN warehouse_productionlog l ON l.production_plan_id=p.id
    WHERE p.work_center_id IS NOT NULL AND p.planned_start IS NOT NULL AND p.planned_end IS NOT NULL GROUP BY p.id`).all()
    .map(p => {
      const progress = p.quantity_needed > 0 ? Math.min(100, Math.max(0, p.produced / p.quantity_needed * 100)) : 0;
      return { id: p.id, group: p.work_center_id,
      content: `Зам №${p.order_number} → ${p.product_name} (${p.quantity_needed} ${p.unit})`,
      start: p.planned_start, end: p.planned_end,
      style: `--production-progress:${progress}%`,
      editable: p.status !== 'completed',
      className: p.status === 'completed' ? 'gantt-order-item-completed'
        : p.status === 'in_progress' ? 'gantt-order-item-progress' : 'gantt-order-item' };
    });
  res.json({ groups, items });
});

function getPlanDependencies(plan) {
  return db.prepare(`SELECT DISTINCT prev.id,prev.status,prev.planned_end,n.name AS product_name
    FROM warehouse_specification s JOIN warehouse_nomenclature n ON n.id=s.ingredient_id
    JOIN warehouse_productionplan prev ON prev.order_id=? AND prev.product_id=s.ingredient_id
    WHERE s.product_id=? AND n.item_type IN ('half_product','product')`).all(plan.order_id, plan.product_id);
}

function getPlanDependents(plan) {
  return db.prepare(`SELECT DISTINCT next.id,next.status,next.planned_start,n.name AS product_name
    FROM warehouse_specification s JOIN warehouse_nomenclature n ON n.id=s.product_id
    JOIN warehouse_productionplan next ON next.order_id=? AND next.product_id=s.product_id
    WHERE s.ingredient_id=? AND n.item_type IN ('half_product','product')`).all(plan.order_id, plan.product_id);
}

router.post('/api/gantt/update', requireCsrf, (req, res) => {
  const id = number(req.body.id), group = number(req.body.group);
  const plan = db.prepare(`SELECT p.*,o.length_per_drum,o.quantity AS order_quantity,n.name AS product_name
    FROM warehouse_productionplan p JOIN warehouse_order o ON o.id=p.order_id
    JOIN warehouse_nomenclature n ON n.id=p.product_id WHERE p.id=?`).get(id);
  if (plan?.status === 'completed') return res.status(409).json({ status: 'error', message: 'Завершене завдання не можна переміщувати.' });
  const center = db.prepare('SELECT * FROM warehouse_workcenter WHERE id=? AND is_active=1').get(group);
  if (!plan || !center || !req.body.start) return res.status(400).json({ status: 'error', message: 'Завдання або лінію не знайдено.' });
  const route = db.prepare('SELECT * FROM warehouse_productrouting WHERE product_id=? AND work_center_id=?').get(plan.product_id, group);
  if (!route) return res.status(400).json({ status: 'error', message: `Для ${plan.product_name} немає маршруту на лінії ${center.code}.` });
  const start = new Date(req.body.start);
  if (Number.isNaN(start.getTime())) return res.status(400).json({ status: 'error', message: 'Некоректний час початку.' });
  for (const dep of getPlanDependencies(plan)) {
    if (dep.status === 'completed') continue;
    if (!dep.planned_end) return res.status(400).json({ status: 'error',
      message: `Спочатку заплануйте та завершіть попередній етап «${dep.product_name}».` });
    if (start < new Date(dep.planned_end)) return res.status(400).json({ status: 'error',
      message: `Етап «${dep.product_name}» має завершитися до початку цього завдання (${new Date(dep.planned_end).toLocaleString('uk-UA')}).` });
  }
  const durationMinutes = route.speed_m_per_min > 0 ? plan.quantity_needed * 1000 / route.speed_m_per_min : 120;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const overlap = db.prepare(`SELECT id FROM warehouse_productionplan WHERE work_center_id=? AND id!=?
    AND planned_start IS NOT NULL AND planned_end IS NOT NULL AND planned_start<? AND planned_end>? LIMIT 1`)
    .get(group, id, end.toISOString(), start.toISOString());
  if (overlap) return res.status(400).json({ status: 'error', message: 'Цей час на лінії вже зайнятий іншим завданням.' });
  for (const next of getPlanDependents(plan)) {
    if (next.planned_start && new Date(next.planned_start) < end) return res.status(400).json({ status: 'error',
      message: `Не можна перенести етап: після нього вже заплановано «${next.product_name}».` });
  }
  db.prepare(`UPDATE warehouse_productionplan SET work_center_id=?,planned_start=?,planned_end=?,duration_hours=? WHERE id=?`)
    .run(group, start.toISOString(), end.toISOString(), Math.round(durationMinutes / 60 * 100) / 100, id);
  res.json({ status: 'success', new_end: end.toISOString() });
});

router.get('/health', (_req, res) => res.json({ status: 'ok' }));
