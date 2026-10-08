# UniDesk · Faculty Portal

## Run it

Install Node.js 20 or newer. Open a terminal in this folder and run:

```powershell
npm start
```

Open `http://localhost:4173`. Create a faculty account with a name, staff ID, work email, and password. During initial setup, select **HR / Approver** to register the one HR account; once set up, that role cannot be self-registered again. The server stores accounts, students, attendance, circulars, events, teachers, and leave requests in `data/campus-desk.json`; passwords are stored as salted hashes.

## Faculty workflow

- **Attendance:** choose course, group, semester 1–6, subject, and date. View the class roster by student name, then mark each student Present, Absent, or Late.
- **Students:** add and manage names and roll numbers with their course, group, and semester.
- **Circulars:** publish notices for all students or a course.
- **Events & Holidays:** add campus dates by year. Republic Day, Independence Day (15 August), and Gandhi Jayanti are listed as national holidays for the selected year.
- **My HR:** faculty see only their own profile and leave requests. The HR role sees the teacher directory and approval queue; only HR can approve or decline requests. Faculty cannot access other teachers' leave records.

The included server runs locally. For staff to share the same information across devices, host it on an HTTPS server and use that address for everyone. It is not connected to a college system.
