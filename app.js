(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { user: null, page: 'dashboard', attendanceStudents: [], attendanceEntries: [] };
  const semesters = Array.from({ length: 6 }, (_, index) => `Semester ${index + 1}`);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  function toast(message) {
    const node = $('#toast'); node.textContent = message; node.classList.add('show');
    window.setTimeout(() => node.classList.remove('show'), 2800);
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not reach UniDesk.');
    return data;
  }
  function fillSemesters(select, firstOption = false) {
    if (firstOption) select.add(new Option('All semesters', ''));
    semesters.forEach((semester) => select.add(new Option(semester, semester)));
  }
  fillSemesters($('#attSemester'));
  fillSemesters($('#studentSemester'), true);
  fillSemesters($('#studentForm select[name="semester"]'));
  $('#attDate').value = today;
  $('#eventYear').value = new Date().getFullYear();
  $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  let accountMode = 'login';
  api('/api/setup').then(({ hrConfigured }) => {
    const hrOption = $('#registerRole').querySelector('option[value="hr"]');
    hrOption.disabled = hrConfigured;
    $('#roleHint').textContent = hrConfigured ? 'The HR account is already set up. Ask HR for access.' : 'The first HR account can review and approve leave requests.';
  }).catch(() => {});
  function updateRegistrationButton() {
    $('#loginSubmit').textContent = accountMode === 'register' ? ($('#registerRole').value === 'hr' ? 'Create HR account' : 'Create account') : 'Sign in';
  }
  $('#registerRole').addEventListener('change', updateRegistrationButton);
  $('#accountModeToggle').addEventListener('click', () => {
    accountMode = accountMode === 'login' ? 'register' : 'login';
    $('#registerFields').hidden = accountMode !== 'register';
    updateRegistrationButton();
    $('#accountModeToggle').textContent = accountMode === 'register' ? 'Already registered? Sign in' : 'Create account';
    $('#loginPassword').minLength = accountMode === 'register' ? 8 : 0;
  });

  async function enterPortal(user) {
    state.user = user;
    const isHr = user.role === 'hr';
    $('#workspaceCaption').textContent = isHr ? 'HR WORKSPACE' : 'FACULTY WORKSPACE';
    $('#summaryLeaveLabel').textContent = isHr ? 'Pending leave approvals' : 'My pending leave requests';
    $('#hrNavLabel').textContent = isHr ? 'HR Management' : 'My HR';
    $('#facultyName').textContent = user.name;
    $('#facultyStaffId').textContent = user.staffId;
    $('#welcomeName').textContent = user.name.split(' ')[0];
    $('#userAvatar').textContent = user.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
    $('#login').hidden = true; $('#app').hidden = false;
    await showPage('dashboard');
  }
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#loginSubmit'); button.disabled = true;
    const email = $('#loginEmail').value.trim().toLowerCase();
    const password = $('#loginPassword').value;
    try {
      let result;
      if (accountMode === 'register') {
        result = await api('/api/register', { method: 'POST', body: JSON.stringify({ email, password, name: $('#registerName').value, staffId: $('#registerStaffId').value, department: $('#registerDepartment').value, role: $('#registerRole').value }) });
      } else result = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      await enterPortal(result.user);
      toast(accountMode === 'register' ? `${result.user.role === 'hr' ? 'HR' : 'Faculty'} account created.` : 'Signed in.');
      accountMode = 'login'; $('#registerFields').hidden = true; updateRegistrationButton(); $('#accountModeToggle').textContent = 'Create account';
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  $('#logoutButton').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
    state.user = null; $('#app').hidden = true; $('#login').hidden = false; $('#loginPassword').value = '';
  });

  async function showPage(page) {
    state.page = page;
    $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
    $$('.side-link[data-page]').forEach((button) => button.classList.toggle('selected', button.dataset.page === page));
    const titles = { dashboard: 'Overview', attendance: 'Attendance', circulars: 'Circulars', events: 'Events & Holidays', students: 'Students', hr: state.user?.role === 'hr' ? 'HR Management' : 'My HR' };
    $('#pageTitle').textContent = titles[page];
    if (page === 'dashboard') await loadOverview();
    if (page === 'attendance') await loadAttendance();
    if (page === 'circulars') await loadCirculars();
    if (page === 'events') await loadEvents();
    if (page === 'students') await loadStudents();
    if (page === 'hr') await loadHR();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('.side-link[data-page]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.go)));

  async function loadOverview() {
    try {
      const [students, circulars, events, leaves] = await Promise.all([
        api('/api/students'), api('/api/circulars'), api(`/api/events?year=${new Date().getFullYear()}`), api('/api/leaves')
      ]);
      $('#summaryStudents').textContent = students.students.length;
      $('#summaryCirculars').textContent = circulars.circulars.length;
      $('#summaryEvents').textContent = events.events.filter((item) => item.date >= today).length;
      $('#summaryLeaves').textContent = leaves.leaves.filter((item) => item.status === 'Pending').length;
      $('#summaryLeaveLabel').textContent = state.user?.role === 'hr' ? 'Pending leave approvals' : 'My pending leave requests';
    } catch (error) { toast(error.message); }
  }

  function attendanceFilters() {
    return { course: $('#attCourse').value, group: $('#attGroup').value, semester: $('#attSemester').value, date: $('#attDate').value || today, subject: $('#attSubject').value.trim() || 'Class attendance' };
  }
  async function loadAttendance() {
    const params = new URLSearchParams(attendanceFilters());
    try {
      const [students, attendance] = await Promise.all([api(`/api/students?${params}`), api(`/api/attendance?${params}`)]);
      state.attendanceStudents = students.students;
      state.attendanceEntries = attendance.entries;
      renderAttendance();
    } catch (error) { toast(error.message); }
  }
  function renderAttendance() {
    const entries = new Map(state.attendanceEntries.map((entry) => [entry.studentId, entry]));
    const roster = state.attendanceStudents;
    $('#rosterCaption').textContent = `${roster.length} students · ${attendanceFilters().course} · ${attendanceFilters().group} · ${attendanceFilters().semester}`;
    const list = $('#attendanceRoster'); list.replaceChildren();
    if (!roster.length) { list.innerHTML = '<p class="empty-state">No students are listed for this class yet. Add students in the Students section to build this roll call.</p>'; return; }
    roster.forEach((student) => {
      const entry = entries.get(student.id);
      const row = document.createElement('article'); row.className = 'roster-row';
      const identity = document.createElement('div'); identity.className = 'student-identity';
      const name = document.createElement('span'); name.className = 'student-name'; name.textContent = student.name;
      const roll = document.createElement('small'); roll.className = 'roll-number'; roll.textContent = `Roll no. ${student.rollNumber}`;
      identity.append(name, roll);
      const status = document.createElement('span'); status.className = `attendance-state ${entry?.status || 'unmarked'}`; status.textContent = entry?.status || 'Not marked';
      const actions = document.createElement('div'); actions.className = 'attendance-actions';
      for (const value of ['present', 'absent', 'late']) {
        const button = document.createElement('button'); button.className = `mark-chip ${value} ${entry?.status === value ? 'chosen' : ''}`; button.textContent = value[0].toUpperCase() + value.slice(1);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api('/api/attendance', { method: 'POST', body: JSON.stringify({ studentId: student.id, ...attendanceFilters(), status: value }) });
            await loadAttendance();
          } catch (error) { toast(error.message); button.disabled = false; }
        });
        actions.append(button);
      }
      row.append(identity, status, actions); list.append(row);
    });
  }
  ['attCourse', 'attGroup', 'attSemester', 'attDate', 'attSubject'].forEach((id) => $(`#${id}`).addEventListener('change', loadAttendance));
  $('#refreshRoster').addEventListener('click', loadAttendance);

  async function loadStudents() {
    const params = new URLSearchParams({ course: $('#studentCourse').value, group: $('#studentGroup').value, semester: $('#studentSemester').value, search: $('#studentSearch').value });
    try {
      const { students } = await api(`/api/students?${params}`);
      const list = $('#studentList'); list.replaceChildren();
      if (!students.length) { list.innerHTML = '<p class="empty-state">No matching students yet. Add the student details above.</p>'; return; }
      students.forEach((student) => {
        const row = document.createElement('article'); row.className = 'roster-row student-row';
        const roll = document.createElement('b'); roll.className = 'roll-number'; roll.textContent = student.rollNumber;
        const name = document.createElement('span'); name.className = 'student-name'; name.textContent = student.name;
        const meta = document.createElement('span'); meta.className = 'student-meta'; meta.textContent = `${student.course} · ${student.group} · ${student.semester}`;
        const remove = document.createElement('button'); remove.className = 'icon-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${student.name}`);
        remove.addEventListener('click', async () => { if (confirm(`Remove ${student.name} from the student list?`)) { await api(`/api/students/${student.id}`, { method: 'DELETE' }); await loadStudents(); } });
        row.append(roll, name, meta, remove); list.append(row);
      });
    } catch (error) { toast(error.message); }
  }
  ['studentCourse', 'studentGroup', 'studentSemester'].forEach((id) => $(`#${id}`).addEventListener('change', loadStudents));
  $('#studentSearch').addEventListener('input', loadStudents);
  $('#studentForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      await api('/api/students', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
      formElement.reset();
      toast('Student added.'); await loadStudents();
    } catch (error) { toast(error.message); }
  });

  async function loadCirculars() {
    try {
      const { circulars } = await api('/api/circulars'); const list = $('#circularList'); list.replaceChildren();
      if (!circulars.length) { list.innerHTML = '<p class="empty-state">No circulars published yet.</p>'; return; }
      circulars.forEach((item) => {
        const card = document.createElement('article'); card.className = 'content-card';
        const head = document.createElement('div'); head.className = 'content-card-head';
        const title = document.createElement('h4'); title.textContent = item.title;
        const date = document.createElement('small'); date.textContent = new Date(item.createdAt).toLocaleDateString();
        head.append(title, date);
        const audience = document.createElement('span'); audience.className = 'tag'; audience.textContent = item.audience;
        const message = document.createElement('p'); message.textContent = item.message;
        const by = document.createElement('small'); by.className = 'byline'; by.textContent = `Posted by ${item.createdBy}`;
        const remove = document.createElement('button'); remove.className = 'text-remove'; remove.textContent = 'Delete'; remove.addEventListener('click', async () => { await api(`/api/circulars/${item.id}`, { method: 'DELETE' }); await loadCirculars(); });
        card.append(head, audience, message, by, remove); list.append(card);
      });
    } catch (error) { toast(error.message); }
  }
  $('#circularForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    try { await api('/api/circulars', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); toast('Circular published.'); await loadCirculars(); }
    catch (error) { toast(error.message); }
  });

  const nationalHolidays = (year) => [
    { id: `national-${year}-01-26`, title: 'Republic Day', date: `${year}-01-26`, kind: 'Holiday', details: 'National holiday' },
    { id: `national-${year}-08-15`, title: 'Independence Day', date: `${year}-08-15`, kind: 'Holiday', details: 'National holiday' },
    { id: `national-${year}-10-02`, title: 'Gandhi Jayanti', date: `${year}-10-02`, kind: 'Holiday', details: 'National holiday' }
  ];
  async function loadEvents() {
    const year = $('#eventYear').value || String(new Date().getFullYear()); $('#eventListTitle').textContent = `Calendar dates · ${year}`;
    try {
      const { events } = await api(`/api/events?year=${encodeURIComponent(year)}`);
      const merged = [...nationalHolidays(Number(year)), ...events].sort((a, b) => a.date.localeCompare(b.date));
      const list = $('#eventList'); list.replaceChildren();
      merged.forEach((item) => {
        const card = document.createElement('article'); card.className = 'calendar-item';
        const date = document.createElement('span'); date.className = 'calendar-date'; date.textContent = new Date(`${item.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const details = document.createElement('div'); details.className = 'calendar-details';
        const title = document.createElement('b'); title.textContent = item.title;
        const subtitle = document.createElement('small'); subtitle.textContent = item.details || item.kind;
        details.append(title, subtitle);
        const tag = document.createElement('span'); tag.className = `tag ${item.kind.toLowerCase()}`; tag.textContent = item.kind;
        card.append(date, details, tag);
        if (!String(item.id).startsWith('national-')) { const remove = document.createElement('button'); remove.className = 'text-remove'; remove.textContent = 'Delete'; remove.addEventListener('click', async () => { await api(`/api/events/${item.id}`, { method: 'DELETE' }); await loadEvents(); }); card.append(remove); }
        list.append(card);
      });
    } catch (error) { toast(error.message); }
  }
  $('#eventYear').addEventListener('change', loadEvents);
  $('#eventForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    try { await api('/api/events', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); toast('Calendar date added.'); await loadEvents(); }
    catch (error) { toast(error.message); }
  });

  async function loadHR() {
    const isHr = state.user?.role === 'hr';
    $('#facultyHrView').hidden = isHr;
    $('#hrAdminView').hidden = !isHr;
    $('#hrPageHeading').textContent = isHr ? 'HR Management' : 'My HR';
    $('#hrPageDescription').textContent = isHr ? 'Manage the faculty directory and review leave requests.' : 'Your profile and your own leave requests.';
    try {
      const [{ teachers }, { leaves }] = await Promise.all([api('/api/teachers'), api('/api/leaves')]);
      const teacherList = $(isHr ? '#hrTeacherList' : '#teacherList'); teacherList.replaceChildren();
      if (!teachers.length) teacherList.innerHTML = `<p class="empty-state">${isHr ? 'No teachers listed yet.' : 'Your profile is not available.'}</p>`;
      teachers.forEach((teacher) => {
        const card = document.createElement('article'); card.className = 'teacher-card';
        const avatar = document.createElement('span'); avatar.className = 'avatar teacher-avatar'; avatar.textContent = teacher.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
        const details = document.createElement('div'); const name = document.createElement('b'); name.textContent = teacher.name; const sub = document.createElement('small'); sub.textContent = `${teacher.staffId} · ${teacher.department || 'Faculty'}`; details.append(name, sub);
        card.append(avatar, details); teacherList.append(card);
      });
      const leaveList = $(isHr ? '#approvalList' : '#leaveList'); leaveList.replaceChildren();
      if (!leaves.length) leaveList.innerHTML = `<p class="empty-state">${isHr ? 'No leave requests to review.' : 'No leave requests recorded yet.'}</p>`;
      leaves.forEach((leave) => {
        const card = document.createElement('article'); card.className = 'leave-card';
        const info = document.createElement('div'); const name = document.createElement('b'); name.textContent = leave.teacherName; const date = document.createElement('small'); date.textContent = `${leave.staffId} · ${leave.startDate} to ${leave.endDate}`; const reason = document.createElement('small'); reason.textContent = leave.reason || 'No reason entered'; info.append(name, date, reason);
        const status = document.createElement('span'); status.className = `leave-status ${leave.status.toLowerCase()}`; status.textContent = leave.status;
        card.append(info, status);
        if (isHr && leave.status === 'Pending') {
          const actions = document.createElement('div'); actions.className = 'leave-actions';
          for (const value of ['Approved', 'Declined']) {
            const button = document.createElement('button'); button.className = value === 'Approved' ? 'mini-primary' : 'mini-secondary'; button.textContent = value;
            button.addEventListener('click', async () => {
              try { await api(`/api/leaves/${leave.id}`, { method: 'PATCH', body: JSON.stringify({ status: value }) }); toast(`Leave ${value.toLowerCase()}.`); await loadHR(); }
              catch (error) { toast(error.message); }
            });
            actions.append(button);
          }
          card.append(actions);
        }
        leaveList.append(card);
      });
    } catch (error) { toast(error.message); }
  }
  $('#teacherForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    try { await api('/api/teachers', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); toast('Teacher added.'); await loadHR(); }
    catch (error) { toast(error.message); }
  });
  $('#leaveForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const data = Object.fromEntries(form);
    try { await api('/api/leaves', { method: 'POST', body: JSON.stringify(data) }); formElement.reset(); toast('Leave request submitted.'); await loadHR(); }
    catch (error) { toast(error.message); }
  });

  api('/api/me').then(({ user }) => enterPortal(user)).catch(() => {});
})();
