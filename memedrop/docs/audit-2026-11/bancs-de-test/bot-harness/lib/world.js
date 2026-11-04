'use strict';
// The fake Discord "world" the bot runs against: users, guilds, channels and
// guild memberships. Shared by the harness (to build interactions) and by the
// fake discord.js module inside the bot process (to answer API calls).
//
// Everything here is constant, so every run sees exactly the same world.

const USERS = {
  alice:   { id: '210000000000000001', username: 'alice', globalName: 'Alice', avatar: 'a11ce0000000000000000000000000aa' },
  bob:     { id: '210000000000000002', username: 'bob', globalName: null, avatar: null },
  carol:   { id: '210000000000000003', username: 'carol', globalName: 'Caro', avatar: 'a_ca201000000000000000000000000cc' },
  dave:    { id: '210000000000000004', username: 'dave', globalName: null, avatar: 'da7e0000000000000000000000000ddd' },
  erin:    { id: '210000000000000005', username: 'erin', globalName: null, avatar: null },
  frank:   { id: '210000000000000006', username: 'frank', globalName: 'Frankie', avatar: 'f2a40000000000000000000000000fff' },
  // Account that Discord no longer knows (users.fetch -> 10013 Unknown User).
  ghost:   { id: '210000000000000007', username: 'ghost', globalName: null, avatar: null, deleted: true },
  // Some other bot on the server (must be filtered out of drop targets).
  memebot: { id: '210000000000000008', username: 'memebot', globalName: null, avatar: null, bot: true },
};

// The bot's own account (client.user).
const SELF = { id: '210000000000000099', username: 'MemeDrop', globalName: null, avatar: 'b0700000000000000000000000000bbb', bot: true };

const GUILDS = {
  G1: { id: '110000000000000001', name: 'Les Potes', icon: '1c0n0000000000000000000000000001',
        members: ['alice', 'bob', 'carol', 'dave', 'frank', 'memebot'] },
  G2: { id: '110000000000000002', name: 'Gaming Squad', icon: null,
        members: ['alice', 'carol', 'bob'] },
};
// A guild id that overlays may still remember but the bot is not in.
const UNKNOWN_GUILD_ID = '110000000000000009';

const CHANNELS = {
  'G1#general':   { id: '310000000000000001', guild: 'G1', name: 'general' },
  'G1#old-memes': { id: '310000000000000003', guild: 'G1', name: 'old-memes' },
  'G2#memes':     { id: '310000000000000002', guild: 'G2', name: 'memes' },
  'DM':           { id: '310000000000000099', guild: null, name: null, dm: true },
};

function userByName(name) {
  const u = USERS[name];
  if (!u) throw new Error(`unknown world user ${name}`);
  return u;
}

function nameById(id) {
  for (const [name, u] of Object.entries(USERS)) if (u.id === id) return name;
  if (id === SELF.id) return 'SELF';
  return null;
}

// Serializable snapshot handed to the bot process at start.
function snapshot() {
  return JSON.parse(JSON.stringify({ USERS, SELF, GUILDS, CHANNELS, UNKNOWN_GUILD_ID }));
}

module.exports = { USERS, SELF, GUILDS, CHANNELS, UNKNOWN_GUILD_ID, userByName, nameById, snapshot };
