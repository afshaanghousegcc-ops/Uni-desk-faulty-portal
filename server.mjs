import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const root = resolve(process.cwd());
const dataDir = resolve(root, 'data');
const dbFile = resolve(dataDir, 'campus-desk.json');
const sessions = new Map();
const defaults = { users: {}, students: [], attendance: [], circulars: [], events: [], teachers: [], leaves: [] };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

await mkdir(dataDir, { recursive: true });
let db;
try { db = { ...defaults, ...JSON.parse(await readFile(dbFile, 'utf8')) }; }
catch { db = { ...defaults }; }
async function saveDb() { await writeFile(dbFile, JSON.stringify(db, null, 2), { mode: 0o600 }); }
function reply(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value));
}
function currentUser(req) { return db.users[sessions.get(cookies(req).campus_session)] || null; }
function cookie(value, age = 604800) {
  return `campus_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
const userRole = (user) => user.role === 'hr' ? 'hr' : 'faculty';
const hrIsConfigured = () => Object.values(db.users).some((user) => user.role === 'hr');
function sendUser(user) { return { id: user.id, name: user.name, email: user.email, staffId: user.staffId, role: userRole(user) }; }
function requireTeacher(req, res) {
  const user = currentUser(req);
  if (!user) { reply(res, 401, { error: 'Please sign in again.' }); return null; }
  return user;
}
async function readJson(req) {
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 1024 * 1024) throw new Error('Request is too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
const makeId = () => randomBytes(12).toString('hex');
const clean = (value, max = 180) => String(value || '').trim().slice(0, max);
const semesterValid = (value) => /^Semester [1-6]$/.test(value);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/setup') return reply(res, 200, { hrConfigured: hrIsConfigured() });
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const body = await readJson(req);
      const email = clean(body.email, 180).toLowerCase();
      const name = clean(body.name, 100);
      const staffId = clean(body.staffId, 40).toUpperCase();
      const password = String(body.password || '');
      const role = body.role === 'hr' ? 'hr' : 'faculty';
      if (!email.includes('@') || !name || !staffId || password.length < 8) return reply(res, 400, { error: 'Enter your name, work email, staff ID, and a password of at least 8 characters.' });
      if (db.users[email]) return reply(res, 409, { error: 'An account already exists for this email.' });
      if (Object.values(db.users).some((item) => item.staffId === staffId)) return reply(res, 409, { error: 'That staff ID is already registered.' });
      if (role === 'hr' && hrIsConfigured()) return reply(res, 403, { error: 'An HR account is already set up. Ask the HR account holder for access.' });
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
      const user = { id: makeId(), email, name, staffId, role, salt, passwordHash, createdAt: new Date().toISOString() };
      db.users[email] = user;
      if (!db.teachers.some((teacher) => teacher.staffId === staffId)) db.teachers.push({ id: user.id, name, staffId, email, department: clean(body.department, 80) || 'Faculty' });
      await saveDb();
      const token = randomBytes(32).toString('hex'); sessions.set(token, email);
      return reply(res, 201, { user: sendUser(user) }, { 'Set-Cookie': cookie(token) });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(req);
      const email = clean(body.email, 180).toLowerCase();
      const user = db.users[email];
      if (!user) return reply(res, 401, { error: 'Email or password is incorrect.' });
      const actual = Buffer.from((await scrypt(String(body.password || ''), user.salt, 64)).toString('hex'), 'hex');
      if (!timingSafeEqual(actual, Buffer.from(user.passwordHash, 'hex'))) return reply(res, 401, { error: 'Email or password is incorrect.' });
      if (user.role !== 'hr') user.role = 'faculty';
      if (!db.teachers.some((teacher) => teacher.staffId === user.staffId)) db.teachers.push({ id: user.id, name: user.name, staffId: user.staffId, email: user.email, department: 'Faculty' });
      await saveDb();
      const token = randomBytes(32).toString('hex'); sessions.set(token, email);
      return reply(res, 200, { user: sendUser(user) }, { 'Set-Cookie': cookie(token) });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(cookies(req).campus_session);
      return reply(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = currentUser(req);
      return user ? reply(res, 200, { user: sendUser(user) }) : reply(res, 401, { error: 'Please sign in.' });
    }

    if (url.pathname.startsWith('/api/')) {
      const teacher = requireTeacher(req, res);
      if (!teacher) return;

      if (req.method === 'GET' && url.pathname === '/api/students') {
        const { course, semester, group, search } = Object.fromEntries(url.searchParams);
        const query = clean(search, 80).toLowerCase();
        const students = db.students.filter((student) => (!course || student.course === course) && (!semester || student.semester === semester) && (!group || student.group === group) && (!query || `${student.rollNumber} ${student.name}`.toLowerCase().includes(query))).sort((a, b) => a.rollNumber.localeCompare(b.rollNumber, undefined, { numeric: true }));
        return reply(res, 200, { students });
      }
      if (req.method === 'POST' && url.pathname === '/api/students') {
        const body = await readJson(req);
        const student = { id: makeId(), rollNumber: clean(body.rollNumber, 40).toUpperCase(), name: clean(body.name, 100), course: clean(body.course, 40), semester: clean(body.semester, 20), group: clean(body.group, 40), createdAt: new Date().toISOString() };
        if (!student.rollNumber || !student.name || !['BCA', 'B.Sc', 'B.Com'].includes(student.course) || !semesterValid(student.semester) || !student.group) return reply(res, 400, { error: 'Enter a roll number, name, course, semester, and group.' });
        if (db.students.some((item) => item.rollNumber === student.rollNumber && item.course === student.course && item.semester === student.semester && item.group === student.group)) return reply(res, 409, { error: 'That roll number is already in this group.' });
        db.students.push(student); await saveDb();
        return reply(res, 201, { student });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/students/')) {
        const id = url.pathname.split('/').pop();
        db.students = db.students.filter((student) => student.id !== id); await saveDb();
        return reply(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/attendance') {
        const { course, semester, group, date, subject } = Object.fromEntries(url.searchParams);
        const entries = db.attendance.filter((entry) => (!course || entry.course === course) && (!semester || entry.semester === semester) && (!group || entry.group === group) && (!date || entry.date === date) && (!subject || entry.subject === subject));
        return reply(res, 200, { entries });
      }
      if (req.method === 'POST' && url.pathname === '/api/attendance') {
        const body = await readJson(req);
        const student = db.students.find((item) => item.id === body.studentId);
        const status = ['present', 'absent', 'late'].includes(body.status) ? body.status : '';
        const date = clean(body.date, 10); const subject = clean(body.subject, 100);
        if (!student || !status || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !subject) return reply(res, 400, { error: 'Choose a student, subject, date, and status.' });
        const index = db.attendance.findIndex((entry) => entry.studentId === student.id && entry.date === date && entry.subject === subject);
        const entry = { id: index >= 0 ? db.attendance[index].id : makeId(), studentId: student.id, rollNumber: student.rollNumber, studentName: student.name, course: student.course, semester: student.semester, group: student.group, subject, date, status, markedBy: teacher.staffId, markedAt: new Date().toISOString() };
        if (index >= 0) db.attendance[index] = entry; else db.attendance.push(entry);
        await saveDb(); return reply(res, 200, { entry });
      }
      if (req.method === 'GET' && url.pathname === '/api/circulars') return reply(res, 200, { circulars: db.circulars.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      if (req.method === 'POST' && url.pathname === '/api/circulars') {
        const body = await readJson(req);
        const title = clean(body.title, 160); const message = clean(body.message, 5000);
        if (!title || !message) return reply(res, 400, { error: 'Enter a title and notice.' });
        const circular = { id: makeId(), title, message, audience: clean(body.audience, 80) || 'All students', createdBy: teacher.name, createdAt: new Date().toISOString() };
        db.circulars.push(circular); await saveDb(); return reply(res, 201, { circular });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/circulars/')) {
        const id = url.pathname.split('/').pop(); db.circulars = db.circulars.filter((item) => item.id !== id); await saveDb(); return reply(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const year = Number(url.searchParams.get('year'));
        const events = db.events.filter((item) => !year || Number(item.date.slice(0, 4)) === year).sort((a, b) => a.date.localeCompare(b.date));
        return reply(res, 200, { events });
      }
      if (req.method === 'POST' && url.pathname === '/api/events') {
        const body = await readJson(req);
        const event = { id: makeId(), title: clean(body.title, 160), date: clean(body.date, 10), kind: body.kind === 'Holiday' ? 'Holiday' : 'Event', details: clean(body.details, 1000), createdBy: teacher.name };
        if (!event.title || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) return reply(res, 400, { error: 'Enter an event name and date.' });
        db.events.push(event); await saveDb(); return reply(res, 201, { event });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/events/')) {
        const id = url.pathname.split('/').pop(); db.events = db.events.filter((item) => item.id !== id); await saveDb(); return reply(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/teachers') {
        if (userRole(teacher) === 'hr') return reply(res, 200, { teachers: db.teachers.slice().sort((a, b) => a.name.localeCompare(b.name)) });
        const ownProfile = db.teachers.find((item) => item.staffId === teacher.staffId) || { id: teacher.id, name: teacher.name, staffId: teacher.staffId, email: teacher.email, department: 'Faculty' };
        return reply(res, 200, { teachers: [ownProfile] });
      }
      if (req.method === 'POST' && url.pathname === '/api/teachers') {
        if (userRole(teacher) !== 'hr') return reply(res, 403, { error: 'Only HR can manage the teacher directory.' });
        const body = await readJson(req);
        const item = { id: makeId(), name: clean(body.name, 100), staffId: clean(body.staffId, 40).toUpperCase(), email: clean(body.email, 180).toLowerCase(), department: clean(body.department, 80) || 'Faculty' };
        if (!item.name || !item.staffId) return reply(res, 400, { error: 'Enter the teacher name and staff ID.' });
        if (db.teachers.some((teacherItem) => teacherItem.staffId === item.staffId)) return reply(res, 409, { error: 'That staff ID is already listed.' });
        db.teachers.push(item); await saveDb(); return reply(res, 201, { teacher: item });
      }
      const ownsLeave = (item) => item.staffId === teacher.staffId && (item.createdById === teacher.id || (!item.createdById && item.createdBy === teacher.name));
      if (req.method === 'GET' && url.pathname === '/api/leaves') {
        const leaves = userRole(teacher) === 'hr' ? db.leaves : db.leaves.filter(ownsLeave);
        return reply(res, 200, { leaves: leaves.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/leaves') {
        const body = await readJson(req);
        const item = { id: makeId(), teacherName: teacher.name, staffId: teacher.staffId, startDate: clean(body.startDate, 10), endDate: clean(body.endDate, 10), reason: clean(body.reason, 500), status: 'Pending', createdBy: teacher.name, createdById: teacher.id, createdAt: new Date().toISOString() };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(item.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(item.endDate) || item.endDate < item.startDate) return reply(res, 400, { error: 'Choose valid leave dates.' });
        db.leaves.push(item); await saveDb(); return reply(res, 201, { leave: item });
      }
      const leaveMatch = url.pathname.match(/^\/api\/leaves\/([a-f0-9]+)$/);
      if (req.method === 'PATCH' && leaveMatch) {
        if (userRole(teacher) !== 'hr') return reply(res, 403, { error: 'Only HR can approve or decline leave requests.' });
        const body = await readJson(req); const item = db.leaves.find((leave) => leave.id === leaveMatch[1]);
        if (!item) return reply(res, 404, { error: 'Leave request not found.' });
        if (!['Approved', 'Declined'].includes(body.status)) return reply(res, 400, { error: 'Choose approve or decline.' });
        item.status = body.status; item.reviewedBy = teacher.name; item.reviewedAt = new Date().toISOString();
        await saveDb(); return reply(res, 200, { leave: item });
      }
      return reply(res, 404, { error: 'Not found.' });
    }

    const filePath = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (filePath !== root && !filePath.startsWith(root + sep)) return reply(res, 403, { error: 'Forbidden.' });
    try {
      if (!(await stat(filePath)).isFile()) return reply(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': mime[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(filePath).pipe(res);
    } catch { reply(res, 404, { error: 'Not found.' }); }
  } catch (error) {
    const status = error.message === 'Request is too large.' ? 413 : 400;
    if (!res.headersSent) reply(res, status, { error: status === 413 ? error.message : 'Could not process the request.' });
  }
});

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`UniDesk listening on http://${host}:${port}`));
