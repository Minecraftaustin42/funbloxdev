const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const MAX_BIO_LENGTH = 280;

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

function ensureUserShape(user) {
  user.sculptCoins = Number.isFinite(user.sculptCoins) ? user.sculptCoins : 0;
  user.diamonds = Number.isFinite(user.diamonds) ? user.diamonds : 0;
  user.points = Number.isFinite(user.points) ? user.points : 0;
  user.friends = Array.isArray(user.friends) ? user.friends : [];
  user.friendRequests = Array.isArray(user.friendRequests) ? user.friendRequests : [];
  user.notifications = Array.isArray(user.notifications) ? user.notifications : [];
  user.avatar = user.avatar && typeof user.avatar === 'object' ? user.avatar : {};

  if (!user.profile || typeof user.profile !== 'object') {
    user.profile = {};
  }

  user.profile.bio = typeof user.profile.bio === 'string' ? user.profile.bio : '';
  user.profile.status = typeof user.profile.status === 'string' ? user.profile.status : 'Ready to sculpt!';
  user.profile.themeColor =
    typeof user.profile.themeColor === 'string' ? user.profile.themeColor : '#4f7fd9';
  user.profile.gamesCreated = Number.isFinite(user.profile.gamesCreated)
    ? user.profile.gamesCreated
    : 0;
  user.profile.joinDate = typeof user.profile.joinDate === 'string' ? user.profile.joinDate : user.createdAt;

  return user;
}

function toPublicUser(user) {
  const cleanUser = ensureUserShape(user);
  return {
    id: cleanUser.id,
    username: cleanUser.username,
    sculptCoins: cleanUser.sculptCoins,
    diamonds: cleanUser.diamonds,
    points: cleanUser.points,
    friends: cleanUser.friends,
    friendRequests: cleanUser.friendRequests,
    notifications: cleanUser.notifications,
    avatar: cleanUser.avatar,
    createdAt: cleanUser.createdAt,
    profile: cleanUser.profile,
  };
}

function getAvatarPreview(avatar) {
  if (avatar && typeof avatar === 'object' && typeof avatar.imageUrl === 'string' && avatar.imageUrl.trim()) {
    return avatar.imageUrl.trim();
  }

  return '/assets/default-avatar.svg';
}

function toProfilePublicView(user, viewerUserId) {
  const cleanUser = ensureUserShape(user);
  const isOwnProfile = viewerUserId ? cleanUser.id === viewerUserId : false;

  return {
    username: cleanUser.username,
    joinDate: cleanUser.profile.joinDate,
    avatar: getAvatarPreview(cleanUser.avatar),
    friendsCount: cleanUser.friends.length,
    gamesCreated: cleanUser.profile.gamesCreated,
    bio: cleanUser.profile.bio,
    status: cleanUser.profile.status,
    themeColor: cleanUser.profile.themeColor,
    canEdit: isOwnProfile,
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

function validateThemeColor(color) {
  if (typeof color !== 'string') {
    return false;
  }

  return /^#[0-9A-Fa-f]{6}$/.test(color.trim());
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
    const now = new Date().toISOString();

    const newUser = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      username: cleanUsername,
      passwordHash,
      sculptCoins: 250,
      diamonds: 5,
      points: 100,
      friends: [],
      friendRequests: [],
      notifications: ['Welcome to PlaySculpt! Start building your first world.'],
      avatar: {},
      createdAt: now,
      lastDailyRewardAt: null,
      profile: {
        bio: '',
        status: 'Ready to sculpt!',
        themeColor: '#4f7fd9',
        gamesCreated: 0,
        joinDate: now,
      },
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

app.get('/api/dashboard-data', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find((item) => item.id === req.session.userId);

    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Session invalid.' });
    }

    const cleanUser = ensureUserShape(user);
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const lastRewardKey = typeof cleanUser.lastDailyRewardAt === 'string'
      ? cleanUser.lastDailyRewardAt.slice(0, 10)
      : null;

    const dailyReward = {
      amount: 25,
      currency: 'SculptCoins',
      claimedToday: lastRewardKey === todayKey,
      nextClaimAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
    };

    return res.json({
      user: {
        username: cleanUser.username,
        sculptCoins: cleanUser.sculptCoins,
        diamonds: cleanUser.diamonds,
        points: cleanUser.points,
        avatarPreview: getAvatarPreview(cleanUser.avatar),
        createdAt: cleanUser.createdAt,
      },
      social: {
        friendsCount: cleanUser.friends.length,
        friendRequestCount: cleanUser.friendRequests.length,
      },
      notifications: cleanUser.notifications.slice(0, 5),
      dailyReward,
      quickLinks: [
        'Friends',
        'Groups',
        'Profile',
        'Avatar',
        'Create Game',
        'Discover',
        'Sculpt City',
      ],
    });
  } catch (error) {
    console.error('Dashboard route error:', error);
    return res.status(500).json({ error: 'Server error while loading dashboard data.' });
  }
});

app.get('/api/profile/:username', async (req, res) => {
  try {
    const username = req.params.username;
    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const user = users.find(
      (item) => item.username.toLowerCase() === username.trim().toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const viewerUserId = req.session.userId || null;
    return res.json({
      profile: toProfilePublicView(user, viewerUserId),
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    return res.status(500).json({ error: 'Server error while fetching profile.' });
  }
});

app.post('/api/profile/update', requireAuth, async (req, res) => {
  try {
    const { username, bio, status, themeColor } = req.body || {};

    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const sessionUser = users.find((item) => item.id === req.session.userId);
    if (!sessionUser) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Session invalid.' });
    }

    if (sessionUser.username.toLowerCase() !== username.trim().toLowerCase()) {
      return res.status(403).json({ error: 'You can only edit your own profile.' });
    }

    const cleanBio = typeof bio === 'string' ? bio.trim() : '';
    const cleanStatus = typeof status === 'string' ? status.trim() : '';
    const cleanThemeColor = typeof themeColor === 'string' ? themeColor.trim() : '';

    if (cleanBio.length > MAX_BIO_LENGTH) {
      return res.status(400).json({ error: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.` });
    }

    if (!validateThemeColor(cleanThemeColor)) {
      return res.status(400).json({ error: 'Theme color must be a valid 6-digit hex color.' });
    }

    ensureUserShape(sessionUser);
    sessionUser.profile.bio = cleanBio;
    sessionUser.profile.status = cleanStatus || 'Ready to sculpt!';
    sessionUser.profile.themeColor = cleanThemeColor;

    await writeUsers(users);

    return res.json({
      message: 'Profile updated successfully.',
      profile: toProfilePublicView(sessionUser, req.session.userId),
    });
  } catch (error) {
    console.error('Profile update error:', error);
    return res.status(500).json({ error: 'Server error while updating profile.' });
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
