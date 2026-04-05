const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'playsculpt.sid',
    secret: process.env.SESSION_SECRET || 'dev_only_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

// serve frontend files
app.use(express.static(path.join(__dirname, 'public')));

async function ensureUsersFile() {
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, '[]', 'utf8');
  }
}

async function readUsers() {
  await ensureUsersFile();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  try {
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    sculptCoins: user.sculptCoins,
    diamonds: user.diamonds,
    points: user.points,
    friends: user.friends,
    friendRequests: user.friendRequests,
    notifications: user.notifications,
    avatar: user.avatar,
    createdAt: user.createdAt,
  };
}

function validateUsername(username) {
  if (typeof username !== 'string') {
    return 'Username is required.';
  }

  const trimmed = username.trim();
  if (trimmed.length < 1 || trimmed.length > 20) {
    return 'Username must be 1 to 20 characters.';
  }

  if (!/^[A-Za-z0-9.]+$/.test(trimmed)) {
    return 'Username can only include letters, numbers, and periods.';
  }

  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    return 'Password is required.';
  }

  if (password.length < 8 || password.length > 100) {
    return 'Password must be 8 to 100 characters.';
  }

  return null;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  next();
}

app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const cleanUsername = username.trim();
    const users = await readUsers();
    const duplicate = users.find(
      (user) => user.username.toLowerCase() === cleanUsername.toLowerCase()
    );

    if (duplicate) {
      return res.status(409).json({ error: 'Username already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const newUser = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      username: cleanUsername,
      passwordHash,
      sculptCoins: 0,
      diamonds: 0,
      points: 0,
      friends: [],
      friendRequests: [],
      notifications: [],
      avatar: {},
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);
    await writeUsers(users);

    req.session.userId = newUser.id;

    return res.status(201).json({
      message: 'Signup successful.',
      user: toPublicUser(newUser),
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Server error during signup.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const cleanUsername = username.trim();
    const users = await readUsers();
    const user = users.find(
      (item) => item.username.toLowerCase() === cleanUsername.toLowerCase()
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    req.session.userId = user.id;

    return res.json({
      message: 'Login successful.',
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Logout error:', error);
      return res.status(500).json({ error: 'Server error during logout.' });
    }

    res.clearCookie('playsculpt.sid');
    return res.json({ message: 'Logged out successfully.' });
  });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find((item) => item.id === req.session.userId);

    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Session invalid.' });
    }

    return res.json({ user: toPublicUser(user) });
  } catch (error) {
    console.error('Me route error:', error);
    return res.status(500).json({ error: 'Server error while fetching user.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`PlaySculpt server running on http://localhost:${PORT}`);
});
