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
const GROUPS_FILE = path.join(__dirname, 'groups.json');
const GAMES_FILE = path.join(__dirname, 'games.json');
const SCULPT_CITY_FILE = path.join(__dirname, 'sculpt-city.json');

const MAX_MESSAGE_LENGTH = 600;
const MAX_BIO_LENGTH = 280;
const GROUP_CREATION_COST = 100;
const GROUP_RENAME_COST = 100;
const MAX_GROUP_ROLES = 100;

const GROUP_PERMISSION_KEYS = [
  'manageGroup',
  'manageDescription',
  'manageAnnouncement',
  'manageAffiliates',
  'manageEnemies',
  'manageRoles',
  'manageMembers',
  'renameGroup',
  'viewWall',
  'postWall',
  'viewMembers',
  'inviteMembers',
];

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
      avatar: sanitizeAvatar({}),
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
  user.avatar = sanitizeAvatar(user.avatar);

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

async function readGroups() {
  return readArrayFile(GROUPS_FILE);
}

async function writeGroups(groups) {
  await writeArrayFile(GROUPS_FILE, groups);
}

async function readGames() {
  return readArrayFile(GAMES_FILE);
}

async function writeGames(games) {
  await writeArrayFile(GAMES_FILE, games);
}


async function readCityData() {
  try {
    const raw = await fs.readFile(SCULPT_CITY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}

  const fallback = {
    plots: {},
    houses: {},
    snapshots: {},
  };
  await fs.writeFile(SCULPT_CITY_FILE, JSON.stringify(fallback, null, 2), 'utf8');
  return fallback;
}

async function writeCityData(data) {
  const safe = data && typeof data === 'object' ? data : { plots: {}, houses: {}, snapshots: {} };
  safe.plots = safe.plots && typeof safe.plots === 'object' ? safe.plots : {};
  safe.houses = safe.houses && typeof safe.houses === 'object' ? safe.houses : {};
  safe.snapshots = safe.snapshots && typeof safe.snapshots === 'object' ? safe.snapshots : {};
  await fs.writeFile(SCULPT_CITY_FILE, JSON.stringify(safe, null, 2), 'utf8');
}

function hashStringNumber(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function createPlotForUser(userId) {
  const index = hashStringNumber(userId) % 64;
  const gridX = index % 8;
  const gridZ = Math.floor(index / 8);
  const spacing = 32;
  return {
    x: (gridX - 3.5) * spacing,
    z: (gridZ - 3.5) * spacing,
    width: 20,
    depth: 20,
  };
}

function createHouseForUser(user) {
  const seed = hashStringNumber(user?.id || user?.username || 'house');
  const hue = seed % 360;
  return {
    wallColor: `hsl(${hue}, 38%, 82%)`,
    roofColor: `hsl(${(hue + 18) % 360}, 45%, 42%)`,
    doorColor: '#6b4428',
    windowColor: '#cce8ff',
    treeColor: '#3a8f43',
    createdAt: new Date().toISOString(),
  };
}

function toCityPlayer(user, snapshot) {
  const clean = ensureUserShape(user);
  const now = Date.now();
  const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    userId: clean.id,
    username: clean.username,
    avatar: clean.avatar,
    position: {
      x: Number.isFinite(base?.position?.x) ? base.position.x : 0,
      y: Number.isFinite(base?.position?.y) ? base.position.y : 1.1,
      z: Number.isFinite(base?.position?.z) ? base.position.z : 0,
    },
    rotationY: Number.isFinite(base.rotationY) ? base.rotationY : 0,
    status: typeof base.status === 'string' ? base.status : '',
    chatBubble: typeof base.chatBubble === 'string' ? base.chatBubble : '',
    bubbleAt: typeof base.bubbleAt === 'string' ? base.bubbleAt : null,
    updatedAt: typeof base.updatedAt === 'string' ? base.updatedAt : new Date(now).toISOString(),
  };
}

function normalizeHexColor(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const clean = value.trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(clean)) {
    return fallback;
  }

  return clean.toLowerCase();
}

function buildAvatarImageUrl(avatar) {
  const safeAvatar = avatar && typeof avatar === 'object' ? avatar : {};
  const skinColor = normalizeHexColor(safeAvatar.skinColor, '#f1c27d');
  const shirtColor = normalizeHexColor(safeAvatar.shirt, '#4f7fd9');
  const pantsColor = normalizeHexColor(safeAvatar.pants, '#2f4f8e');
  const hatColor = normalizeHexColor(safeAvatar.hat, '#303030');

  const faceType = typeof safeAvatar.face === 'string' ? safeAvatar.face : 'smile';
  const hatType = typeof safeAvatar.hatType === 'string' ? safeAvatar.hatType : 'none';

  const eyeY = 44;
  const mouth =
    faceType === 'serious'
      ? '<line x1="48" y1="58" x2="80" y2="58" stroke="#222" stroke-width="3" />'
      : faceType === 'wink'
        ? '<path d="M47 58 Q65 71 81 57" stroke="#222" stroke-width="3" fill="none" />'
        : '<path d="M47 56 Q64 72 81 56" stroke="#222" stroke-width="3" fill="none" />';

  const eyes =
    faceType === 'wink'
      ? `<circle cx="50" cy="${eyeY}" r="3" fill="#222" /><line x1="73" y1="${eyeY}" x2="82" y2="${eyeY}" stroke="#222" stroke-width="3" />`
      : `<circle cx="50" cy="${eyeY}" r="3" fill="#222" /><circle cx="78" cy="${eyeY}" r="3" fill="#222" />`;

  const hat =
    hatType === 'cap'
      ? `<rect x="34" y="20" width="60" height="10" rx="5" fill="${hatColor}" /><rect x="58" y="30" width="40" height="7" rx="3" fill="${hatColor}" />`
      : hatType === 'crown'
        ? `<path d="M34 30 L42 14 L54 30 L64 14 L74 30 L86 14 L94 30 Z" fill="${hatColor}" />`
        : '';

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" fill="#dfe9ff" />
      ${hat}
      <circle cx="64" cy="50" r="24" fill="${skinColor}" />
      ${eyes}
      ${mouth}
      <rect x="38" y="76" width="52" height="26" rx="4" fill="${shirtColor}" />
      <rect x="38" y="102" width="24" height="20" fill="${pantsColor}" />
      <rect x="66" y="102" width="24" height="20" fill="${pantsColor}" />
    </svg>
  `;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function sanitizeAvatar(avatar) {
  const source = avatar && typeof avatar === 'object' ? avatar : {};
  const safe = {
    skinColor: normalizeHexColor(source.skinColor, '#f1c27d'),
    shirt: normalizeHexColor(source.shirt, '#4f7fd9'),
    pants: normalizeHexColor(source.pants, '#2f4f8e'),
    face: ['smile', 'serious', 'wink', 'grin', 'surprised', 'angry'].includes(source.face) ? source.face : 'smile',
    hatType: ['none', 'cap', 'crown'].includes(source.hatType) ? source.hatType : 'none',
    hat: normalizeHexColor(source.hat, '#303030'),
  };

  safe.imageUrl = buildAvatarImageUrl(safe);
  return safe;
}

function sanitizePermissionShape(permissions) {
  const safePermissions = {};

  for (const key of GROUP_PERMISSION_KEYS) {
    safePermissions[key] = Boolean(permissions && permissions[key]);
  }

  return safePermissions;
}

function createRole({ id, name, rankId, permissions }) {
  return {
    id,
    name,
    rankId,
    permissions: sanitizePermissionShape(permissions),
  };
}

function getDefaultGroupRoles(ownerUserId) {
  return [
    createRole({
      id: 'owner',
      name: 'Owner',
      rankId: 255,
      permissions: Object.fromEntries(GROUP_PERMISSION_KEYS.map((key) => [key, true])),
    }),
    createRole({
      id: 'admin',
      name: 'Admin',
      rankId: 200,
      permissions: {
        manageGroup: true,
        manageDescription: true,
        manageAnnouncement: true,
        manageAffiliates: true,
        manageEnemies: true,
        manageRoles: true,
        manageMembers: true,
        renameGroup: true,
        viewWall: true,
        postWall: true,
        viewMembers: true,
        inviteMembers: true,
      },
    }),
    createRole({
      id: 'member',
      name: 'Member',
      rankId: 1,
      permissions: {
        manageGroup: false,
        manageDescription: false,
        manageAnnouncement: false,
        manageAffiliates: false,
        manageEnemies: false,
        manageRoles: false,
        manageMembers: false,
        renameGroup: false,
        viewWall: true,
        postWall: true,
        viewMembers: true,
        inviteMembers: false,
      },
    }),
  ];
}

function ensureGroupShape(group) {
  if (!group || typeof group !== 'object') {
    return null;
  }

  const safeGroup = {
    id: typeof group.id === 'string' ? group.id : `group_${Date.now()}`,
    name: typeof group.name === 'string' ? group.name : 'Untitled Group',
    description: typeof group.description === 'string' ? group.description : '',
    ownerUserId: typeof group.ownerUserId === 'string' ? group.ownerUserId : '',
    announcement: typeof group.announcement === 'string' ? group.announcement : '',
    affiliates: Array.isArray(group.affiliates) ? uniqueStringArray(group.affiliates) : [],
    enemies: Array.isArray(group.enemies) ? uniqueStringArray(group.enemies) : [],
    createdAt: typeof group.createdAt === 'string' ? group.createdAt : new Date().toISOString(),
    updatedAt: typeof group.updatedAt === 'string' ? group.updatedAt : new Date().toISOString(),
    roleAssignments:
      group.roleAssignments && typeof group.roleAssignments === 'object'
        ? group.roleAssignments
        : {},
    joinRequests: Array.isArray(group.joinRequests) ? uniqueStringArray(group.joinRequests) : [],
  };

  const roles = Array.isArray(group.roles) ? group.roles : [];
  const fallbackRoles = getDefaultGroupRoles(safeGroup.ownerUserId);
  safeGroup.roles = roles.length
    ? roles
        .filter((role) => role && typeof role === 'object')
        .map((role, index) =>
          createRole({
            id: typeof role.id === 'string' ? role.id : `role_${index + 1}`,
            name: typeof role.name === 'string' ? role.name : `Role ${index + 1}`,
            rankId: Number.isFinite(role.rankId) ? role.rankId : index + 1,
            permissions: role.permissions,
          })
        )
    : fallbackRoles;

  if (!safeGroup.roles.find((role) => role.id === 'owner')) {
    safeGroup.roles.unshift(fallbackRoles[0]);
  }

  if (!safeGroup.roles.find((role) => role.id === 'admin')) {
    safeGroup.roles.push(fallbackRoles[1]);
  }

  if (!safeGroup.roles.find((role) => role.id === 'member')) {
    safeGroup.roles.push(fallbackRoles[2]);
  }

  const memberIds = Array.isArray(group.memberIds) ? uniqueStringArray(group.memberIds) : [];

  if (!memberIds.includes(safeGroup.ownerUserId)) {
    memberIds.unshift(safeGroup.ownerUserId);
  }

  safeGroup.memberIds = memberIds.filter(Boolean);

  if (!safeGroup.roleAssignments[safeGroup.ownerUserId]) {
    safeGroup.roleAssignments[safeGroup.ownerUserId] = 'owner';
  }

  for (const memberId of safeGroup.memberIds) {
    if (!safeGroup.roleAssignments[memberId]) {
      safeGroup.roleAssignments[memberId] = 'member';
    }
  }

  return safeGroup;
}

function getRoleById(group, roleId) {
  return group.roles.find((role) => role.id === roleId);
}

function getMemberRole(group, userId) {
  const roleId = group.roleAssignments?.[userId] || (group.ownerUserId === userId ? 'owner' : 'member');
  return getRoleById(group, roleId) || getRoleById(group, 'member');
}

function hasGroupPermission(group, userId, permissionKey) {
  const role = getMemberRole(group, userId);
  return Boolean(role?.permissions?.[permissionKey]);
}

function buildGroupSummary(group, users, viewerUserId = null) {
  const owner = users.find((user) => user.id === group.ownerUserId);
  const memberCount = Array.isArray(group.memberIds) ? group.memberIds.length : 0;

  return {
    id: group.id,
    name: group.name,
    description: group.description,
    ownerUsername: owner ? owner.username : 'Unknown',
    announcement: group.announcement,
    affiliates: group.affiliates,
    enemies: group.enemies,
    memberCount,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    joined: viewerUserId ? group.memberIds.includes(viewerUserId) : false,
  };
}

function buildGroupDetail(group, users, viewerUserId = null) {
  const summary = buildGroupSummary(group, users, viewerUserId);
  const members = (group.memberIds || [])
    .map((memberId) => users.find((user) => user.id === memberId))
    .filter(Boolean)
    .map((member) => {
      const role = getMemberRole(group, member.id);
      return {
        userId: member.id,
        username: member.username,
        avatar: getAvatarPreview(member.avatar),
        roleId: role?.id || 'member',
        roleName: role?.name || 'Member',
        rankId: role?.rankId ?? 1,
      };
    })
    .sort((a, b) => b.rankId - a.rankId || a.username.localeCompare(b.username));

  const viewerRole = viewerUserId ? getMemberRole(group, viewerUserId) : null;

  return {
    ...summary,
    roles: group.roles,
    memberList: members,
    viewerRole: viewerRole
      ? {
          id: viewerRole.id,
          name: viewerRole.name,
          rankId: viewerRole.rankId,
          permissions: viewerRole.permissions,
        }
      : null,
  };
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
      avatar: sanitizeAvatar({}),
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

app.get('/api/avatar/me', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const user = users.find((item) => item.id === req.session.userId);

    if (!user) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    return res.json({ avatar: sanitizeAvatar(user.avatar) });
  } catch (error) {
    console.error('Avatar fetch error:', error);
    return res.status(500).json({ error: 'Server error while loading avatar.' });
  }
});

app.post('/api/avatar/update', requireAuth, async (req, res) => {
  try {
    const { username, avatar } = req.body || {};

    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    const users = await readUsers();
    const currentUser = users.find((item) => item.id === req.session.userId);

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    if (currentUser.username.toLowerCase() !== username.trim().toLowerCase()) {
      return res.status(403).json({ error: 'Only the profile owner can edit avatar.' });
    }

    currentUser.avatar = sanitizeAvatar(avatar);
    await writeUsers(users);

    return res.json({
      message: 'Avatar updated successfully.',
      avatar: currentUser.avatar,
      user: toPublicUser(currentUser),
    });
  } catch (error) {
    console.error('Avatar update error:', error);
    return res.status(500).json({ error: 'Server error while saving avatar.' });
  }
});

app.post('/api/games/create', requireAuth, async (req, res) => {
  try {
    const { title, description, thumbnail, isPublic, studioState } = req.body || {};

    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Game title is required.' });
    }

    const cleanTitle = title.trim();
    if (cleanTitle.length < 3 || cleanTitle.length > 80) {
      return res.status(400).json({ error: 'Game title must be 3 to 80 characters.' });
    }

    const cleanDescription = typeof description === 'string' ? description.trim() : '';
    if (cleanDescription.length > 1000) {
      return res.status(400).json({ error: 'Description must be 1000 characters or fewer.' });
    }

    const users = await readUsers();
    const games = await readGames();
    const currentUser = users.find((item) => item.id === req.session.userId);

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    const now = new Date().toISOString();
    const game = {
      id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      title: cleanTitle,
      description: cleanDescription,
      creator: currentUser.username,
      creatorUserId: currentUser.id,
      thumbnail: typeof thumbnail === 'string' && thumbnail.trim() ? thumbnail.trim() : '/assets/default-avatar.svg',
      visits: 0,
      public: Boolean(isPublic),
      studioState: studioState && typeof studioState === 'object' ? studioState : { objects: [] },
      createdAt: now,
      updatedAt: now,
    };

    games.push(game);

    ensureUserShape(currentUser);
    currentUser.profile.gamesCreated = Number.isFinite(currentUser.profile.gamesCreated)
      ? currentUser.profile.gamesCreated + 1
      : 1;

    await writeGames(games);
    await writeUsers(users);

    return res.status(201).json({ message: 'Game created.', game });
  } catch (error) {
    console.error('Game create error:', error);
    return res.status(500).json({ error: 'Server error while creating game.' });
  }
});

app.get('/api/games/my', requireAuth, async (req, res) => {
  try {
    const games = await readGames();
    const ownGames = games
      .filter((game) => game && game.creatorUserId === req.session.userId)
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    return res.json({ games: ownGames });
  } catch (error) {
    console.error('My games error:', error);
    return res.status(500).json({ error: 'Server error while loading your games.' });
  }
});

app.get('/api/games/:id', requireAuth, async (req, res) => {
  try {
    const games = await readGames();
    const game = games.find((item) => item && item.id === req.params.id);

    if (!game) {
      return res.status(404).json({ error: 'Game not found.' });
    }

    const isCreator = game.creatorUserId === req.session.userId;
    if (!game.public && !isCreator) {
      return res.status(403).json({ error: 'This game is private.' });
    }

    game.visits = Number.isFinite(game.visits) ? game.visits + 1 : 1;
    await writeGames(games);

    return res.json({ game, isCreator });
  } catch (error) {
    console.error('Game detail error:', error);
    return res.status(500).json({ error: 'Server error while loading game.' });
  }
});

app.post('/api/games/update', requireAuth, async (req, res) => {
  try {
    const { id, title, description, thumbnail, isPublic, studioState } = req.body || {};

    if (typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({ error: 'Game id is required.' });
    }

    const games = await readGames();
    const game = games.find((item) => item && item.id === id.trim());

    if (!game) {
      return res.status(404).json({ error: 'Game not found.' });
    }

    if (game.creatorUserId !== req.session.userId) {
      return res.status(403).json({ error: 'Only the creator can edit this game.' });
    }

    if (typeof title === 'string' && title.trim()) {
      const cleanTitle = title.trim();
      if (cleanTitle.length < 3 || cleanTitle.length > 80) {
        return res.status(400).json({ error: 'Game title must be 3 to 80 characters.' });
      }
      game.title = cleanTitle;
    }

    if (typeof description === 'string') {
      const cleanDescription = description.trim();
      if (cleanDescription.length > 1000) {
        return res.status(400).json({ error: 'Description must be 1000 characters or fewer.' });
      }
      game.description = cleanDescription;
    }

    if (typeof thumbnail === 'string' && thumbnail.trim()) {
      game.thumbnail = thumbnail.trim();
    }

    if (typeof isPublic === 'boolean') {
      game.public = isPublic;
    }

    if (studioState && typeof studioState === 'object') {
      game.studioState = studioState;
    }

    game.updatedAt = new Date().toISOString();

    await writeGames(games);

    return res.json({ message: 'Game updated.', game });
  } catch (error) {
    console.error('Game update error:', error);
    return res.status(500).json({ error: 'Server error while updating game.' });
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


app.get('/groups', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);

    return res.json({
      groups: groups
        .map((group) => buildGroupSummary(group, users, req.session.userId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    console.error('Groups list error:', error);
    return res.status(500).json({ error: 'Server error while loading groups.' });
  }
});

app.post('/groups/create', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body || {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required.' });
    }

    const cleanName = name.trim();
    if (cleanName.length < 3 || cleanName.length > 50) {
      return res.status(400).json({ error: 'Group name must be 3 to 50 characters.' });
    }

    const cleanDescription = typeof description === 'string' ? description.trim() : '';
    if (cleanDescription.length > 500) {
      return res.status(400).json({ error: 'Group description must be 500 characters or fewer.' });
    }

    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);
    const currentUser = users.find((user) => user.id === req.session.userId);

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    if (currentUser.sculptCoins < GROUP_CREATION_COST) {
      return res.status(400).json({
        error: `You need ${GROUP_CREATION_COST} Sculpt coins to create a group.`,
      });
    }

    if (groups.some((group) => group.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: 'A group with this name already exists.' });
    }

    currentUser.sculptCoins -= GROUP_CREATION_COST;

    const now = new Date().toISOString();
    const group = ensureGroupShape({
      id: `group_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      name: cleanName,
      description: cleanDescription,
      ownerUserId: currentUser.id,
      memberIds: [currentUser.id],
      announcement: '',
      affiliates: [],
      enemies: [],
      roles: getDefaultGroupRoles(currentUser.id),
      roleAssignments: {
        [currentUser.id]: 'owner',
      },
      joinRequests: [],
      createdAt: now,
      updatedAt: now,
    });

    groups.push(group);

    await writeUsers(users);
    await writeGroups(groups);

    return res.status(201).json({
      message: `Group created for ${GROUP_CREATION_COST} Sculpt coins.`,
      group: buildGroupDetail(group, users, req.session.userId),
      user: toPublicUser(currentUser),
    });
  } catch (error) {
    console.error('Group create error:', error);
    return res.status(500).json({ error: 'Server error while creating group.' });
  }
});

app.post('/groups/join', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.body || {};

    if (typeof groupId !== 'string' || !groupId.trim()) {
      return res.status(400).json({ error: 'groupId is required.' });
    }

    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);
    const currentUser = users.find((user) => user.id === req.session.userId);
    const targetGroup = groups.find((group) => group.id === groupId.trim());

    if (!currentUser) {
      return res.status(401).json({ error: 'Session invalid.' });
    }

    if (!targetGroup) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    if (targetGroup.memberIds.includes(currentUser.id)) {
      return res.status(409).json({ error: 'You are already a member of this group.' });
    }

    targetGroup.memberIds.push(currentUser.id);
    targetGroup.roleAssignments[currentUser.id] = 'member';
    targetGroup.updatedAt = new Date().toISOString();

    await writeGroups(groups);

    return res.json({
      message: `Joined ${targetGroup.name}.`,
      group: buildGroupDetail(targetGroup, users, req.session.userId),
    });
  } catch (error) {
    console.error('Group join error:', error);
    return res.status(500).json({ error: 'Server error while joining group.' });
  }
});

app.get('/groups/:id', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);
    const group = groups.find((item) => item.id === req.params.id);

    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    return res.json({ group: buildGroupDetail(group, users, req.session.userId) });
  } catch (error) {
    console.error('Group detail error:', error);
    return res.status(500).json({ error: 'Server error while loading group page.' });
  }
});

app.post('/groups/:id/update', requireAuth, async (req, res) => {
  try {
    const { name, description, announcement, affiliates, enemies } = req.body || {};
    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);
    const group = groups.find((item) => item.id === req.params.id);
    const currentUser = users.find((user) => user.id === req.session.userId);

    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    if (!currentUser || !group.memberIds.includes(currentUser.id)) {
      return res.status(403).json({ error: 'You must be a group member to edit group settings.' });
    }

    const isOwner = group.ownerUserId === currentUser.id;

    if (typeof description === 'string') {
      if (!isOwner && !hasGroupPermission(group, currentUser.id, 'manageDescription')) {
        return res.status(403).json({ error: 'You do not have permission to edit description.' });
      }

      if (description.trim().length > 500) {
        return res.status(400).json({ error: 'Description must be 500 characters or fewer.' });
      }

      group.description = description.trim();
    }

    if (typeof announcement === 'string') {
      if (!isOwner && !hasGroupPermission(group, currentUser.id, 'manageAnnouncement')) {
        return res.status(403).json({ error: 'You do not have permission to edit announcements.' });
      }

      if (announcement.trim().length > 300) {
        return res.status(400).json({ error: 'Announcement must be 300 characters or fewer.' });
      }

      group.announcement = announcement.trim();
    }

    if (Array.isArray(affiliates)) {
      if (!isOwner && !hasGroupPermission(group, currentUser.id, 'manageAffiliates')) {
        return res.status(403).json({ error: 'You do not have permission to edit affiliates.' });
      }

      group.affiliates = uniqueStringArray(affiliates).slice(0, 100);
    }

    if (Array.isArray(enemies)) {
      if (!isOwner && !hasGroupPermission(group, currentUser.id, 'manageEnemies')) {
        return res.status(403).json({ error: 'You do not have permission to edit enemies.' });
      }

      group.enemies = uniqueStringArray(enemies).slice(0, 100);
    }

    if (typeof name === 'string' && name.trim()) {
      if (!isOwner && !hasGroupPermission(group, currentUser.id, 'renameGroup')) {
        return res.status(403).json({ error: 'You do not have permission to rename this group.' });
      }

      if (currentUser.sculptCoins < GROUP_RENAME_COST) {
        return res.status(400).json({ error: `Renaming costs ${GROUP_RENAME_COST} Sculpt coins.` });
      }

      const cleanName = name.trim();
      if (cleanName.length < 3 || cleanName.length > 50) {
        return res.status(400).json({ error: 'Group name must be 3 to 50 characters.' });
      }

      const duplicate = groups.find(
        (item) => item.id !== group.id && item.name.toLowerCase() === cleanName.toLowerCase()
      );

      if (duplicate) {
        return res.status(409).json({ error: 'Another group already uses this name.' });
      }

      currentUser.sculptCoins -= GROUP_RENAME_COST;
      group.name = cleanName;
    }

    group.updatedAt = new Date().toISOString();

    await writeUsers(users);
    await writeGroups(groups);

    return res.json({
      message: 'Group updated successfully.',
      group: buildGroupDetail(group, users, req.session.userId),
      user: toPublicUser(currentUser),
    });
  } catch (error) {
    console.error('Group update error:', error);
    return res.status(500).json({ error: 'Server error while updating group.' });
  }
});

app.post('/groups/:id/roles/create', requireAuth, async (req, res) => {
  try {
    const { roleId, name, rankId, permissions } = req.body || {};

    if (typeof roleId !== 'string' || !roleId.trim()) {
      return res.status(400).json({ error: 'roleId is required.' });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Role name is required.' });
    }

    if (!Number.isInteger(rankId) || rankId < 0 || rankId > 255) {
      return res.status(400).json({ error: 'rankId must be an integer from 0 to 255.' });
    }

    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);
    const group = groups.find((item) => item.id === req.params.id);

    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    if (!hasGroupPermission(group, req.session.userId, 'manageRoles')) {
      return res.status(403).json({ error: 'You do not have permission to manage roles.' });
    }

    if (group.roles.length >= MAX_GROUP_ROLES) {
      return res.status(400).json({ error: `Maximum role count is ${MAX_GROUP_ROLES}.` });
    }

    const cleanRoleId = roleId.trim().toLowerCase();
    if (group.roles.some((role) => role.id === cleanRoleId)) {
      return res.status(409).json({ error: 'Role id already exists.' });
    }

    group.roles.push(
      createRole({
        id: cleanRoleId,
        name: name.trim(),
        rankId,
        permissions,
      })
    );

    group.updatedAt = new Date().toISOString();
    await writeGroups(groups);

    return res.status(201).json({ group: buildGroupDetail(group, users, req.session.userId) });
  } catch (error) {
    console.error('Group role create error:', error);
    return res.status(500).json({ error: 'Server error while creating group role.' });
  }
});

app.post('/groups/:id/members/role', requireAuth, async (req, res) => {
  try {
    const { memberUserId, roleId } = req.body || {};

    if (typeof memberUserId !== 'string' || !memberUserId.trim()) {
      return res.status(400).json({ error: 'memberUserId is required.' });
    }

    if (typeof roleId !== 'string' || !roleId.trim()) {
      return res.status(400).json({ error: 'roleId is required.' });
    }

    const users = await readUsers();
    const groups = (await readGroups()).map((group) => ensureGroupShape(group)).filter(Boolean);
    const group = groups.find((item) => item.id === req.params.id);

    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    if (!hasGroupPermission(group, req.session.userId, 'manageMembers')) {
      return res.status(403).json({ error: 'You do not have permission to manage members.' });
    }

    if (!group.memberIds.includes(memberUserId)) {
      return res.status(404).json({ error: 'Member not found in this group.' });
    }

    if (memberUserId === group.ownerUserId) {
      return res.status(400).json({ error: 'Owner role cannot be changed.' });
    }

    const role = getRoleById(group, roleId.trim());
    if (!role) {
      return res.status(404).json({ error: 'Role not found.' });
    }

    group.roleAssignments[memberUserId] = role.id;
    group.updatedAt = new Date().toISOString();

    await writeGroups(groups);

    return res.json({ group: buildGroupDetail(group, users, req.session.userId) });
  } catch (error) {
    console.error('Group member role error:', error);
    return res.status(500).json({ error: 'Server error while updating member role.' });
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



app.get('/api/city/bootstrap', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const cityData = await readCityData();
    const currentUser = users.find((user) => user.id === req.session.userId);

    if (!currentUser) return res.status(401).json({ error: 'Session invalid.' });

    if (!cityData.plots[currentUser.id]) cityData.plots[currentUser.id] = createPlotForUser(currentUser.id);
    if (!cityData.houses[currentUser.id]) cityData.houses[currentUser.id] = createHouseForUser(currentUser);

    const players = users.map((user) => toCityPlayer(user, cityData.snapshots[user.id]));

    await writeCityData(cityData);

    return res.json({
      world: {
        cityName: 'Sculpt City',
        plots: cityData.plots,
        houses: cityData.houses,
      },
      me: toCityPlayer(currentUser, cityData.snapshots[currentUser.id]),
      players,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error('City bootstrap error:', error);
    return res.status(500).json({ error: 'Server error while loading Sculpt City.' });
  }
});

app.get('/api/city/players', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const cityData = await readCityData();
    const players = users.map((user) => toCityPlayer(user, cityData.snapshots[user.id]));
    return res.json({ players, serverTime: new Date().toISOString() });
  } catch (error) {
    console.error('City players error:', error);
    return res.status(500).json({ error: 'Server error while syncing city players.' });
  }
});

app.post('/api/city/sync', requireAuth, async (req, res) => {
  try {
    const { position, rotationY, status } = req.body || {};
    const cityData = await readCityData();
    const now = new Date().toISOString();

    cityData.snapshots[req.session.userId] = {
      ...(cityData.snapshots[req.session.userId] || {}),
      position: {
        x: Number.isFinite(position?.x) ? position.x : 0,
        y: Number.isFinite(position?.y) ? position.y : 1.1,
        z: Number.isFinite(position?.z) ? position.z : 0,
      },
      rotationY: Number.isFinite(rotationY) ? rotationY : 0,
      status: typeof status === 'string' ? status.slice(0, 60) : '',
      updatedAt: now,
    };

    await writeCityData(cityData);
    return res.json({ ok: true, updatedAt: now });
  } catch (error) {
    console.error('City sync error:', error);
    return res.status(500).json({ error: 'Server error while syncing player position.' });
  }
});

app.post('/api/city/chat-bubble', requireAuth, async (req, res) => {
  try {
    const { text } = req.body || {};
    const bubble = typeof text === 'string' ? text.trim().slice(0, 80) : '';
    if (!bubble) return res.status(400).json({ error: 'Bubble text is required.' });

    const cityData = await readCityData();
    cityData.snapshots[req.session.userId] = {
      ...(cityData.snapshots[req.session.userId] || {}),
      chatBubble: bubble,
      bubbleAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await writeCityData(cityData);
    return res.json({ ok: true });
  } catch (error) {
    console.error('City chat bubble error:', error);
    return res.status(500).json({ error: 'Server error while posting chat bubble.' });
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

  socket.on('city:sync-placeholder', (payload, callback) => {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    socket.broadcast.emit('city:player-placeholder', {
      userId,
      position: safePayload.position || { x: 0, y: 1.1, z: 0 },
      rotationY: Number.isFinite(safePayload.rotationY) ? safePayload.rotationY : 0,
      updatedAt: new Date().toISOString(),
    });
    callback?.({ ok: true });
  });

  socket.on('city:bubble-placeholder', (payload, callback) => {
    const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 80) : '';
    if (!text) {
      callback?.({ ok: false, error: 'Bubble text required.' });
      return;
    }

    socket.broadcast.emit('city:bubble-placeholder', {
      userId,
      text,
      bubbleAt: new Date().toISOString(),
    });
    callback?.({ ok: true });
  });

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
