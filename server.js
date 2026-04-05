const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;

const USERS_FILE = path.join(__dirname, 'users.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

const MAX_MESSAGE_LENGTH = 600;
const MAX_BIO_LENGTH = 280;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
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
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

async function ensureJsonFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '[]', 'utf8');
  }
}

async function readArrayFile(filePath) {
  await ensureJsonFile(filePath);
  const raw = await fs.readFile(filePath, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeArrayFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function uniqueStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function ensureUserShape(user) {
  if (!user || typeof user !== 'object') {
    return {
      id: '',
      username: '',
      passwordHash: '',
      sculptCoins: 0,
      diamonds: 0,
      points: 0,
      friends: [],
      friendRequests: [],
      sentFriendRequests: [],
      notifications: [],
      avatar: {},
      createdAt: new Date().toISOString(),
      lastDailyRewardAt: null,
      profile: {
        bio: '',
        status: 'Ready to sculpt!',
        themeColor: '#4f7fd9',
        gamesCreated: 0,
        joinDate: new Date().toISOString(),
      },
    };
  }

  user.sculptCoins = Number.isFinite(user.sculptCoins) ? user.sculptCoins : 0;
  user.diamonds = Number.isFinite(user.diamonds) ? user.diamonds : 0;
  user.points = Number.isFinite(user.points) ? user.points : 0;
  user.friends = uniqueStringArray(user.friends);
  user.friendRequests = uniqueStringArray(user.friendRequests);
  user.sentFriendRequests = uniqueStringArray(user.sentFriendRequests);
  user.notifications = Array.isArray(user.notifications) ? user.notifications : [];
  user.avatar = user.avatar && typeof user.avatar === 'object' ? user.avatar : {};

  if (!user.profile || typeof user.profile !== 'object') {
    user.profile = {};
  }

  user.profile.bio = typeof user.profile.bio === 'string' ? user.profile.bio : '';
  user.profile.status =
    typeof user.profile.status === 'string' ? user.profile.status : 'Ready to sculpt!';
  user.profile.themeColor =
    typeof user.profile.themeColor === 'string' ? user.profile.themeColor : '#4f7fd9';
  user.profile.gamesCreated = Number.isFinite(user.profile.gamesCreated)
    ? user.profile.gamesCreated
    : 0;
  user.profile.joinDate =
    typeof user.profile.joinDate === 'string'
      ? user.profile.joinDate
      : user.createdAt || new Date().toISOString();

  return user;
}

async function readUsers() {
  const users = await readArrayFile(USERS_FILE);
  return users.map((user) => ensureUserShape(user));
}

async function writeUsers(users) {
  await writeArrayFile(USERS_FILE, users);
}

async function readNotifications() {
  return readArrayFile(NOTIFICATIONS_FILE);
}

async function writeNotifications(notifications) {
  await writeArrayFile(NOTIFICATIONS_FILE, notifications);
}

async function readMessages() {
  return readArrayFile(MESSAGES_FILE);
}

async function writeMessages(messages) {
  await writeArrayFile(MESSAGES_FILE, messages);
}

function getAvatarPreview(avatar) {
  if (
    avatar &&
    typeof avatar === 'object' &&
    typeof avatar.imageUrl === 'string' &&
    avatar.imageUrl.trim()
  ) {
    return avatar.imageUrl.trim();
  }

  return '/assets/default-avatar.svg';
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
    sentFriendRequests: cleanUser.sentFriendRequests,
    notifications: cleanUser.notifications,
    avatar: cleanUser.avatar,
    createdAt: cleanUser.createdAt,
    profile: cleanUser.profile,
  };
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

function findUserByUsername(users, username) {
  return users.find(
    (user) => user.username.toLowerCase() === username.trim().toLowerCase()
  );
}

function areFriends(userA, userB) {
  return userA.friends.includes(userB.id) && userB.friends.includes(userA.id);
}

function getConversationKey(idA, idB) {
  return [idA, idB].sort().join(':');
}

async function createNotification({ userId, type, text, actionLink = '' }) {
  const notifications = await readNotifications();

  const notification = {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    userId,
    type,
    text,
    createdAt: new Date().toISOString(),
    read: false,
    actionLink,
  };

  notifications.push(notification);
  await writeNotifications(notifications);

  return notification;
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
    const duplicate = findUserByUsername(users, cleanUsername);

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
      sentFriendRequests: [],
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

    await createNotification({
      userId: newUser.id,
      type: 'system_message',
      text: 'Welcome to PlaySculpt! Explore your dashboard and start creating.',
      actionLink: '/dashboard.html',
    });

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

    const users = await readUsers();
    const user = findUserByUsername(users, username);

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

    const notifications = await readNotifications();
    const ownNotifications = notifications
      .filter((notification) => notification.userId === user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const now = new Date();
    const cleanUser = ensureUserShape(user);
    const todayKey = now.toISOString().slice(0, 10);
    const lastRewardKey =
      typeof cleanUser.lastDailyRewardAt === 'string'
        ? cleanUser.lastDailyRewardAt.slice(0, 10)
        : null;

    const dailyReward = {
      amount: 25,
      currency: 'SculptCoins',
      claimedToday: lastRewardKey === todayKey,
      nextClaimAt: new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      ).toISOString(),
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
      notificationsPreview: ownNotifications.slice(0, 5),
      unreadNotifications: ownNotifications.filter((notification) => !notification.read).length,
      dailyReward,
      quickLinks: [
        'Friends',
        'Groups',
        'Profile',
        'Avatar',
        'Create Game',
        'Discover',
        'Sculpt City',
        'Chat',
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
    const user = findUserByUsername(users, username);

    if (!user) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const viewerUserId = req.session?.userId || null;

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
      return res
        .status(400)
        .json({ error: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.` });
    }

    if (!validateThemeColor(cleanThemeColor)) {
      return res
        .status(400)
        .json({ error: 'Theme color must be a valid 6-digit hex color.' });
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

app.post('/api/friends/send', requireAuth, async (req, res) => {
  try {
    const { username } = req.body || {};
    const usernameError = validateUsername(username);

    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);
    const targetUser = findUserByUsername(users, username);

    if (!currentUser || !targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (currentUser.id === targetUser.id) {
      return res
        .status(400)
        .json({ error: 'You cannot send a friend request to yourself.' });
    }

    if (areFriends(currentUser, targetUser)) {
      return res.status(409).json({ error: 'You are already friends.' });
    }

    if (
      targetUser.friendRequests.includes(currentUser.id) ||
      currentUser.sentFriendRequests.includes(targetUser.id)
    ) {
      return res.status(409).json({ error: 'Friend request already sent.' });
    }

    if (currentUser.friendRequests.includes(targetUser.id)) {
      return res.status(409).json({
        error: 'This user already sent you a friend request. Accept it instead.',
      });
    }

    targetUser.friendRequests.push(currentUser.id);
    currentUser.sentFriendRequests.push(targetUser.id);

    await writeUsers(users);

    await createNotification({
      userId: targetUser.id,
      type: 'friend_request',
      text: `${currentUser.username} sent you a friend request.`,
      actionLink: '/friends.html',
    });

    return res.json({ message: `Friend request sent to ${targetUser.username}.` });
  } catch (error) {
    console.error('Friend send error:', error);
    return res.status(500).json({ error: 'Server error while sending friend request.' });
  }
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  try {
    const { username } = req.body || {};
    const usernameError = validateUsername(username);

    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);
    const requester = findUserByUsername(users, username);

    if (!currentUser || !requester) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (!currentUser.friendRequests.includes(requester.id)) {
      return res.status(400).json({ error: 'Friend request not found.' });
    }

    currentUser.friendRequests = currentUser.friendRequests.filter(
      (id) => id !== requester.id
    );
    requester.sentFriendRequests = requester.sentFriendRequests.filter(
      (id) => id !== currentUser.id
    );

    if (!currentUser.friends.includes(requester.id)) {
      currentUser.friends.push(requester.id);
    }

    if (!requester.friends.includes(currentUser.id)) {
      requester.friends.push(currentUser.id);
    }

    await writeUsers(users);

    await createNotification({
      userId: requester.id,
      type: 'friend_accept',
      text: `${currentUser.username} accepted your friend request.`,
      actionLink: `/profile.html?username=${encodeURIComponent(currentUser.username)}`,
    });

    return res.json({ message: `You are now friends with ${requester.username}.` });
  } catch (error) {
    console.error('Friend accept error:', error);
    return res.status(500).json({ error: 'Server error while accepting friend request.' });
  }
});

app.post('/api/friends/decline', requireAuth, async (req, res) => {
  try {
    const { username } = req.body || {};
    const usernameError = validateUsername(username);

    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);
    const requester = findUserByUsername(users, username);

    if (!currentUser || !requester) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (!currentUser.friendRequests.includes(requester.id)) {
      return res.status(400).json({ error: 'Friend request not found.' });
    }

    currentUser.friendRequests = currentUser.friendRequests.filter(
      (id) => id !== requester.id
    );
    requester.sentFriendRequests = requester.sentFriendRequests.filter(
      (id) => id !== currentUser.id
    );

    await writeUsers(users);

    return res.json({ message: `Declined friend request from ${requester.username}.` });
  } catch (error) {
    console.error('Friend decline error:', error);
    return res.status(500).json({ error: 'Server error while declining friend request.' });
  }
});

app.post('/api/friends/remove', requireAuth, async (req, res) => {
  try {
    const { username } = req.body || {};
    const usernameError = validateUsername(username);

    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);
    const targetUser = findUserByUsername(users, username);

    if (!currentUser || !targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    currentUser.friends = currentUser.friends.filter((id) => id !== targetUser.id);
    targetUser.friends = targetUser.friends.filter((id) => id !== currentUser.id);

    currentUser.sentFriendRequests = currentUser.sentFriendRequests.filter(
      (id) => id !== targetUser.id
    );
    currentUser.friendRequests = currentUser.friendRequests.filter(
      (id) => id !== targetUser.id
    );
    targetUser.sentFriendRequests = targetUser.sentFriendRequests.filter(
      (id) => id !== currentUser.id
    );
    targetUser.friendRequests = targetUser.friendRequests.filter(
      (id) => id !== currentUser.id
    );

    await writeUsers(users);

    return res.json({ message: `Removed ${targetUser.username} from your friends.` });
  } catch (error) {
    console.error('Friend remove error:', error);
    return res.status(500).json({ error: 'Server error while removing friend.' });
  }
});

app.get('/api/friends/list', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    const friends = currentUser.friends
      .map((friendId) => users.find((user) => user.id === friendId))
      .filter(Boolean)
      .map((friend) => ({
        username: friend.username,
        avatar: getAvatarPreview(friend.avatar),
        status: friend.profile.status,
        themeColor: friend.profile.themeColor,
      }));

    return res.json({ friends });
  } catch (error) {
    console.error('Friend list error:', error);
    return res.status(500).json({ error: 'Server error while loading friends.' });
  }
});

app.get('/api/friends/requests', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    const requests = currentUser.friendRequests
      .map((requesterId) => users.find((user) => user.id === requesterId))
      .filter(Boolean)
      .map((user) => ({
        username: user.username,
        avatar: getAvatarPreview(user.avatar),
        status: user.profile.status,
      }));

    return res.json({ requests });
  } catch (error) {
    console.error('Friend requests error:', error);
    return res
      .status(500)
      .json({ error: 'Server error while loading friend requests.' });
  }
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const notifications = await readNotifications();
    const own = notifications
      .filter((notification) => notification.userId === req.session.userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({
      notifications: own,
      unreadCount: own.filter((notification) => !notification.read).length,
    });
  } catch (error) {
    console.error('Notifications fetch error:', error);
    return res.status(500).json({ error: 'Server error while fetching notifications.' });
  }
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    const notifications = await readNotifications();
    let updated = 0;

    for (const notification of notifications) {
      if (notification.userId !== req.session.userId) {
        continue;
      }

      if (!id || notification.id === id) {
        if (!notification.read) {
          notification.read = true;
          updated += 1;
        }
      }
    }

    await writeNotifications(notifications);
    return res.json({ message: 'Notifications updated.', updated });
  } catch (error) {
    console.error('Notifications read error:', error);
    return res.status(500).json({ error: 'Server error while updating notifications.' });
  }
});

app.post('/api/notifications/delete', requireAuth, async (req, res) => {
  try {
    const { id } = req.body || {};

    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'Notification id is required.' });
    }

    const notifications = await readNotifications();
    const beforeCount = notifications.length;
    const filtered = notifications.filter(
      (notification) =>
        !(notification.userId === req.session.userId && notification.id === id)
    );

    await writeNotifications(filtered);

    if (beforeCount === filtered.length) {
      return res.status(404).json({ error: 'Notification not found.' });
    }

    return res.json({ message: 'Notification deleted.' });
  } catch (error) {
    console.error('Notifications delete error:', error);
    return res.status(500).json({ error: 'Server error while deleting notification.' });
  }
});

app.post('/api/notifications/system', requireAuth, async (req, res) => {
  try {
    const { text, actionLink } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text is required.' });
    }

    const notification = await createNotification({
      userId: req.session.userId,
      type: 'system_message',
      text: text.trim(),
      actionLink: typeof actionLink === 'string' ? actionLink : '/dashboard.html',
    });

    return res.status(201).json({ notification });
  } catch (error) {
    console.error('System notification error:', error);
    return res.status(500).json({ error: 'Server error while creating system notification.' });
  }
});

app.post('/api/game-invites/send', requireAuth, async (req, res) => {
  try {
    const { username, gameName } = req.body || {};

    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    if (typeof gameName !== 'string' || !gameName.trim()) {
      return res.status(400).json({ error: 'Game name is required.' });
    }

    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);
    const targetUser = findUserByUsername(users, username);

    if (!currentUser || !targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await createNotification({
      userId: targetUser.id,
      type: 'game_invite',
      text: `${currentUser.username} invited you to play ${gameName.trim()}.`,
      actionLink: '/dashboard.html',
    });

    return res.json({ message: `Invite sent to ${targetUser.username}.` });
  } catch (error) {
    console.error('Game invite error:', error);
    return res.status(500).json({ error: 'Server error while sending game invite.' });
  }
});

app.get('/api/chat/conversations', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const messages = await readMessages();
    const currentUser = users.find((item) => item.id === req.session.userId);

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    const conversationMap = new Map();

    for (const message of messages) {
      const participants = [message.fromUserId, message.toUserId];

      if (!participants.includes(currentUser.id)) {
        continue;
      }

      const otherUserId =
        message.fromUserId === currentUser.id ? message.toUserId : message.fromUserId;

      if (!currentUser.friends.includes(otherUserId)) {
        continue;
      }

      const key = getConversationKey(currentUser.id, otherUserId);
      const existing = conversationMap.get(key);

      if (!existing || new Date(message.createdAt) > new Date(existing.lastMessage.createdAt)) {
        conversationMap.set(key, {
          otherUserId,
          lastMessage: message,
        });
      }
    }

    const conversations = currentUser.friends
      .map((friendId) => {
        const friend = users.find((user) => user.id === friendId);

        if (!friend) {
          return null;
        }

        const key = getConversationKey(currentUser.id, friend.id);
        const info = conversationMap.get(key);

        return {
          username: friend.username,
          avatar: getAvatarPreview(friend.avatar),
          lastMessageText: info ? info.lastMessage.text : '',
          lastMessageAt: info ? info.lastMessage.createdAt : '',
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

    return res.json({ conversations });
  } catch (error) {
    console.error('Conversations error:', error);
    return res.status(500).json({ error: 'Server error while loading conversations.' });
  }
});

app.get('/api/chat/history/:username', requireAuth, async (req, res) => {
  try {
    const username = req.params.username;
    const usernameError = validateUsername(username);

    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const messages = await readMessages();
    const currentUser = users.find((item) => item.id === req.session.userId);
    const targetUser = findUserByUsername(users, username);

    if (!currentUser || !targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (!areFriends(currentUser, targetUser)) {
      return res.status(403).json({ error: 'You can only chat with friends.' });
    }

    const history = messages
      .filter((message) => {
        const betweenCurrentAndTarget =
          (message.fromUserId === currentUser.id && message.toUserId === targetUser.id) ||
          (message.fromUserId === targetUser.id && message.toUserId === currentUser.id);

        return betweenCurrentAndTarget;
      })
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return res.json({
      target: {
        username: targetUser.username,
        avatar: getAvatarPreview(targetUser.avatar),
      },
      messages: history,
    });
  } catch (error) {
    console.error('Chat history error:', error);
    return res.status(500).json({ error: 'Server error while loading message history.' });
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

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true,
  },
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  if (!socket.request.session || !socket.request.session.userId) {
    return next(new Error('Unauthorized'));
  }

  return next();
});

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  const userRoom = `user:${userId}`;

  socket.join(userRoom);

  socket.on('chat:send', async (payload, callback) => {
    try {
      const toUsername = typeof payload?.toUsername === 'string' ? payload.toUsername : '';
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';

      const usernameError = validateUsername(toUsername);
      if (usernameError) {
        callback?.({ ok: false, error: usernameError });
        return;
      }

      if (!text) {
        callback?.({ ok: false, error: 'Message cannot be empty.' });
        return;
      }

      if (text.length > MAX_MESSAGE_LENGTH) {
        callback?.({
          ok: false,
          error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
        });
        return;
      }

      const users = await readUsers();
      const sender = users.find((item) => item.id === userId);
      const receiver = findUserByUsername(users, toUsername);

      if (!sender || !receiver) {
        callback?.({ ok: false, error: 'User not found.' });
        return;
      }

      if (!areFriends(sender, receiver)) {
        callback?.({ ok: false, error: 'You can only chat with friends.' });
        return;
      }

      const messages = await readMessages();

      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        fromUserId: sender.id,
        fromUsername: sender.username,
        toUserId: receiver.id,
        toUsername: receiver.username,
        text,
        createdAt: new Date().toISOString(),
      };

      messages.push(message);
      await writeMessages(messages);

      io.to(`user:${sender.id}`).emit('chat:message', message);
      io.to(`user:${receiver.id}`).emit('chat:message', message);

      callback?.({ ok: true, message });
    } catch (error) {
      console.error('Socket chat send error:', error);
      callback?.({ ok: false, error: 'Server error while sending message.' });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`PlaySculpt server running on http://localhost:${PORT}`);
});
