'use strict';
// Fake `discord.js` (v14 surface) used inside the bot process by the harness.
//
// It answers API calls from the constant world model (lib/world.js), adds a
// small async latency to every simulated REST/gateway call, and reports every
// observable side effect (interaction responses, channel messages, DMs,
// presence/command registration, login/destroy) to the harness over IPC.
//
// Caching follows discord.js semantics because refactors often swap
// `fetch()` for `cache.get()`:
//   - users.fetch(id)/members.fetch(id) return the cached object when present
//     (no API call) unless { force: true };
//   - interaction.user, interaction.member and resolved option users/members
//     are added to the caches when an interaction arrives;
//   - the bot has no GuildMembers intent, so nothing evicts stale members.

const { EventEmitter } = require('events');

const H = globalThis.__mdHarness;
if (!H) throw new Error('fake discord.js must be loaded through the harness preload');
const W = H.world;

// ───────────────────────────── Collection ─────────────────────────────────
class Collection extends Map {
  ensure(key, defaultValueGenerator) {
    if (this.has(key)) return this.get(key);
    const v = defaultValueGenerator(key, this);
    this.set(key, v);
    return v;
  }
  hasAll(...keys) { return keys.every((k) => super.has(k)); }
  hasAny(...keys) { return keys.some((k) => super.has(k)); }
  first(amount) {
    if (amount === undefined) return this.values().next().value;
    if (amount < 0) return this.last(amount * -1);
    return [...this.values()].slice(0, amount);
  }
  firstKey(amount) {
    if (amount === undefined) return this.keys().next().value;
    if (amount < 0) return this.lastKey(amount * -1);
    return [...this.keys()].slice(0, amount);
  }
  last(amount) {
    const arr = [...this.values()];
    if (amount === undefined) return arr[arr.length - 1];
    if (amount < 0) return this.first(amount * -1);
    if (!amount) return [];
    return arr.slice(-amount);
  }
  lastKey(amount) {
    const arr = [...this.keys()];
    if (amount === undefined) return arr[arr.length - 1];
    if (amount < 0) return this.firstKey(amount * -1);
    if (!amount) return [];
    return arr.slice(-amount);
  }
  at(index) { return [...this.values()].at(index); }
  keyAt(index) { return [...this.keys()].at(index); }
  random(amount) {
    const arr = [...this.values()];
    if (amount === undefined) return arr[Math.floor(Math.random() * arr.length)];
    return Array.from({ length: Math.min(amount, arr.length) }, () => arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
  }
  reverse() {
    const entries = [...this.entries()].reverse();
    this.clear();
    for (const [k, v] of entries) this.set(k, v);
    return this;
  }
  find(fn, thisArg) {
    for (const [k, v] of this) if (fn.call(thisArg, v, k, this)) return v;
    return undefined;
  }
  findKey(fn, thisArg) {
    for (const [k, v] of this) if (fn.call(thisArg, v, k, this)) return k;
    return undefined;
  }
  findLast(fn, thisArg) {
    const entries = [...this.entries()];
    for (let i = entries.length - 1; i >= 0; i--) if (fn.call(thisArg, entries[i][1], entries[i][0], this)) return entries[i][1];
    return undefined;
  }
  findLastKey(fn, thisArg) {
    const entries = [...this.entries()];
    for (let i = entries.length - 1; i >= 0; i--) if (fn.call(thisArg, entries[i][1], entries[i][0], this)) return entries[i][0];
    return undefined;
  }
  sweep(fn, thisArg) {
    const before = this.size;
    for (const [k, v] of this) if (fn.call(thisArg, v, k, this)) this.delete(k);
    return before - this.size;
  }
  filter(fn, thisArg) {
    const out = new this.constructor[Symbol.species]();
    for (const [k, v] of this) if (fn.call(thisArg, v, k, this)) out.set(k, v);
    return out;
  }
  partition(fn, thisArg) {
    const a = new this.constructor[Symbol.species]();
    const b = new this.constructor[Symbol.species]();
    for (const [k, v] of this) (fn.call(thisArg, v, k, this) ? a : b).set(k, v);
    return [a, b];
  }
  flatMap(fn, thisArg) {
    const colls = this.map(fn, thisArg);
    return new this.constructor[Symbol.species]().concat(...colls);
  }
  map(fn, thisArg) {
    const out = [];
    for (const [k, v] of this) out.push(fn.call(thisArg, v, k, this));
    return out;
  }
  mapValues(fn, thisArg) {
    const out = new this.constructor[Symbol.species]();
    for (const [k, v] of this) out.set(k, fn.call(thisArg, v, k, this));
    return out;
  }
  some(fn, thisArg) {
    for (const [k, v] of this) if (fn.call(thisArg, v, k, this)) return true;
    return false;
  }
  every(fn, thisArg) {
    for (const [k, v] of this) if (!fn.call(thisArg, v, k, this)) return false;
    return true;
  }
  reduce(fn, initialValue) {
    let acc;
    let first = true;
    if (arguments.length > 1) { acc = initialValue; first = false; }
    for (const [k, v] of this) {
      if (first) { acc = v; first = false; continue; }
      acc = fn(acc, v, k, this);
    }
    if (first) throw new TypeError('Reduce of empty collection with no initial value');
    return acc;
  }
  each(fn, thisArg) { this.forEach(fn, thisArg); return this; }
  tap(fn, thisArg) { fn.call(thisArg, this); return this; }
  clone() { return new this.constructor[Symbol.species](this); }
  concat(...colls) {
    const out = this.clone();
    for (const c of colls) for (const [k, v] of c) out.set(k, v);
    return out;
  }
  equals(coll) {
    if (!coll) return false;
    if (this === coll) return true;
    if (this.size !== coll.size) return false;
    for (const [k, v] of this) if (!coll.has(k) || v !== coll.get(k)) return false;
    return true;
  }
  sort(compareFunction = Collection.defaultSort) {
    const entries = [...this.entries()];
    entries.sort((a, b) => compareFunction(a[1], b[1], a[0], b[0]));
    super.clear();
    for (const [k, v] of entries) super.set(k, v);
    return this;
  }
  toSorted(compareFunction = Collection.defaultSort) { return this.clone().sort(compareFunction); }
  intersect(other) {
    const out = new this.constructor[Symbol.species]();
    for (const [k, v] of this) if (other.has(k)) out.set(k, v);
    return out;
  }
  difference(other) {
    const out = new this.constructor[Symbol.species]();
    for (const [k, v] of this) if (!other.has(k)) out.set(k, v);
    return out;
  }
  toJSON() { return [...this.values()]; }
  static defaultSort(a, b) { return Number(a > b) || Number(a === b) - 1; }
}

// ───────────────────────────── Constants ──────────────────────────────────
const GatewayIntentBits = {
  Guilds: 1, GuildMembers: 2, GuildModeration: 4, GuildBans: 4, GuildEmojisAndStickers: 8, GuildExpressions: 8,
  GuildIntegrations: 16, GuildWebhooks: 32, GuildInvites: 64, GuildVoiceStates: 128, GuildPresences: 256,
  GuildMessages: 512, GuildMessageReactions: 1024, GuildMessageTyping: 2048, DirectMessages: 4096,
  DirectMessageReactions: 8192, DirectMessageTyping: 16384, MessageContent: 32768, GuildScheduledEvents: 65536,
  AutoModerationConfiguration: 1048576, AutoModerationExecution: 2097152, GuildMessagePolls: 16777216,
  DirectMessagePolls: 33554432,
};
const Partials = { User: 0, Channel: 1, GuildMember: 2, Message: 3, Reaction: 4, GuildScheduledEvent: 5, ThreadMember: 6, SoundboardSound: 7, Poll: 8, PollAnswer: 9 };
const Events = {
  ApplicationCommandPermissionsUpdate: 'applicationCommandPermissionsUpdate', AutoModerationActionExecution: 'autoModerationActionExecution',
  CacheSweep: 'cacheSweep', ChannelCreate: 'channelCreate', ChannelDelete: 'channelDelete', ChannelPinsUpdate: 'channelPinsUpdate',
  ChannelUpdate: 'channelUpdate', ClientReady: 'ready', Debug: 'debug', Error: 'error', GuildAvailable: 'guildAvailable',
  GuildBanAdd: 'guildBanAdd', GuildBanRemove: 'guildBanRemove', GuildCreate: 'guildCreate', GuildDelete: 'guildDelete',
  GuildMemberAdd: 'guildMemberAdd', GuildMemberAvailable: 'guildMemberAvailable', GuildMemberRemove: 'guildMemberRemove',
  GuildMembersChunk: 'guildMembersChunk', GuildMemberUpdate: 'guildMemberUpdate', GuildUnavailable: 'guildUnavailable',
  GuildUpdate: 'guildUpdate', InteractionCreate: 'interactionCreate', Invalidated: 'invalidated', MessageCreate: 'messageCreate',
  MessageDelete: 'messageDelete', MessageReactionAdd: 'messageReactionAdd', MessageReactionRemove: 'messageReactionRemove',
  MessageUpdate: 'messageUpdate', PresenceUpdate: 'presenceUpdate', ShardDisconnect: 'shardDisconnect', ShardError: 'shardError',
  ShardReady: 'shardReady', ShardReconnecting: 'shardReconnecting', ShardResume: 'shardResume', TypingStart: 'typingStart',
  UserUpdate: 'userUpdate', VoiceStateUpdate: 'voiceStateUpdate', Warn: 'warn', WebhooksUpdate: 'webhooksUpdate',
};
const MessageFlags = {
  Crossposted: 1, IsCrosspost: 2, SuppressEmbeds: 4, SourceMessageDeleted: 8, Urgent: 16, HasThread: 32, Ephemeral: 64,
  Loading: 128, FailedToMentionSomeRolesInThread: 256, SuppressNotifications: 4096, IsVoiceMessage: 8192,
  HasSnapshot: 16384, IsComponentsV2: 32768,
};
const ChannelType = {
  GuildText: 0, DM: 1, GuildVoice: 2, GroupDM: 3, GuildCategory: 4, GuildAnnouncement: 5, AnnouncementThread: 10,
  PublicThread: 11, PrivateThread: 12, GuildStageVoice: 13, GuildDirectory: 14, GuildForum: 15, GuildMedia: 16,
};
const InteractionType = { Ping: 1, ApplicationCommand: 2, MessageComponent: 3, ApplicationCommandAutocomplete: 4, ModalSubmit: 5 };
const ApplicationCommandType = { ChatInput: 1, User: 2, Message: 3, PrimaryEntryPoint: 4 };
const ApplicationCommandOptionType = { Subcommand: 1, SubcommandGroup: 2, String: 3, Integer: 4, Boolean: 5, User: 6, Channel: 7, Role: 8, Mentionable: 9, Number: 10, Attachment: 11 };
const InteractionContextType = { Guild: 0, BotDM: 1, PrivateChannel: 2 };
const ApplicationIntegrationType = { GuildInstall: 0, UserInstall: 1 };
const ActivityType = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Custom: 4, Competing: 5 };
const PresenceUpdateStatus = { Online: 'online', DoNotDisturb: 'dnd', Idle: 'idle', Invisible: 'invisible', Offline: 'offline' };
const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5, Premium: 6 };
const ComponentType = { ActionRow: 1, Button: 2, StringSelect: 3, TextInput: 4, UserSelect: 5, RoleSelect: 6, MentionableSelect: 7, ChannelSelect: 8 };
const TextInputStyle = { Short: 1, Paragraph: 2 };
const Colors = { Default: 0, White: 0xffffff, Aqua: 0x1abc9c, Green: 0x57f287, Blue: 0x3498db, Yellow: 0xfee75c, Purple: 0x9b59b6, Gold: 0xf1c40f, Orange: 0xe67e22, Red: 0xed4245, Grey: 0x95a5a6, Blurple: 0x5865f2, Fuchsia: 0xeb459e };
const PermissionFlagsBits = {
  CreateInstantInvite: 1n << 0n, KickMembers: 1n << 1n, BanMembers: 1n << 2n, Administrator: 1n << 3n, ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n, AddReactions: 1n << 6n, ViewAuditLog: 1n << 7n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n, EmbedLinks: 1n << 14n, AttachFiles: 1n << 15n, ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n, UseExternalEmojis: 1n << 18n, ManageRoles: 1n << 28n, ManageWebhooks: 1n << 29n,
  UseApplicationCommands: 1n << 31n, ModerateMembers: 1n << 40n,
};
const TimestampStyles = { ShortTime: 't', LongTime: 'T', ShortDate: 'd', LongDate: 'D', ShortDateTime: 'f', LongDateTime: 'F', RelativeTime: 'R' };
const RESTJSONErrorCodes = { UnknownChannel: 10003, UnknownGuild: 10004, UnknownMember: 10007, UnknownMessage: 10008, UnknownUser: 10013, UnknownInteraction: 10062, CannotSendMessagesToThisUser: 50007, InteractionHasAlreadyBeenAcknowledged: 40060 };

class BitField {
  constructor(bits = 0) { this.bitfield = this.constructor.resolve(bits); }
  static resolve(bit) {
    if (typeof bit === 'number' || typeof bit === 'bigint') return bit;
    if (bit instanceof BitField) return bit.bitfield;
    if (Array.isArray(bit)) return bit.map((b) => this.resolve(b)).reduce((a, b) => a | b, this.DefaultBit);
    if (typeof bit === 'string') {
      if (this.Flags[bit] !== undefined) return this.Flags[bit];
      if (!Number.isNaN(Number(bit))) return typeof this.DefaultBit === 'bigint' ? BigInt(bit) : Number(bit);
    }
    return this.DefaultBit;
  }
  has(bit) { bit = this.constructor.resolve(bit); return (this.bitfield & bit) === bit; }
  any(bit) { bit = this.constructor.resolve(bit); return (this.bitfield & bit) !== this.constructor.DefaultBit; }
  add(...bits) { for (const b of bits) this.bitfield |= this.constructor.resolve(b); return this; }
  remove(...bits) { for (const b of bits) this.bitfield &= ~this.constructor.resolve(b); return this; }
  toArray() { return Object.keys(this.constructor.Flags).filter((k) => this.has(this.constructor.Flags[k])); }
  serialize() { const o = {}; for (const k of Object.keys(this.constructor.Flags)) o[k] = this.has(this.constructor.Flags[k]); return o; }
  equals(bit) { return this.bitfield === this.constructor.resolve(bit); }
  valueOf() { return this.bitfield; }
  toJSON() { return typeof this.bitfield === 'number' ? this.bitfield : this.bitfield.toString(); }
  *[Symbol.iterator]() { yield* this.toArray(); }
}
BitField.Flags = {};
BitField.DefaultBit = 0;
class IntentsBitField extends BitField {}
IntentsBitField.Flags = GatewayIntentBits;
class MessageFlagsBitField extends BitField {}
MessageFlagsBitField.Flags = MessageFlags;
class PermissionsBitField extends BitField {}
PermissionsBitField.Flags = PermissionFlagsBits;
PermissionsBitField.DefaultBit = 0n;
PermissionsBitField.All = Object.values(PermissionFlagsBits).reduce((a, b) => a | b, 0n);

// ───────────────────────────── Errors ─────────────────────────────────────
const DJS_MESSAGES = {
  InteractionAlreadyReplied: 'The reply to this interaction has already been sent or deferred.',
  InteractionNotReplied: 'The reply to this interaction has not been sent or deferred.',
  InteractionEphemeralReplied: 'Ephemeral responses cannot be deleted.',
  CommandInteractionOptionNotFound: (name) => `Required option "${name}" not found.`,
  CommandInteractionOptionType: (name, type, expected) => `Option "${name}" is of type: ${type}; expected ${expected}.`,
  CommandInteractionOptionEmpty: (name, type) => `Required option "${name}" is of type: ${type}; expected a non-empty value.`,
  CommandInteractionOptionNoSubcommand: 'No subcommand specified for interaction.',
  CommandInteractionOptionNoSubcommandGroup: 'No subcommand group specified for interaction.',
  TokenInvalid: 'An invalid token was provided.',
  GuildMembersTimeout: "Members didn't arrive in time.",
};
const DiscordjsErrorCodes = Object.fromEntries(Object.keys(DJS_MESSAGES).map((k) => [k, k]));
function djsMessage(code, args) {
  const m = DJS_MESSAGES[code];
  return typeof m === 'function' ? m(...args) : (m || code);
}
class DiscordjsError extends Error {
  constructor(code, ...args) { super(djsMessage(code, args)); this.code = code; }
  get name() { return `Error [${this.code}]`; }
}
class DiscordjsTypeError extends TypeError {
  constructor(code, ...args) { super(djsMessage(code, args)); this.code = code; }
  get name() { return `TypeError [${this.code}]`; }
}
class DiscordjsRangeError extends RangeError {
  constructor(code, ...args) { super(djsMessage(code, args)); this.code = code; }
  get name() { return `RangeError [${this.code}]`; }
}
class DiscordAPIError extends Error {
  constructor(code, message, status, method, url) {
    super(message);
    this.code = code; this.status = status; this.method = method; this.url = url;
    this.rawError = { message, code }; this.requestBody = { files: undefined, json: undefined };
  }
  get name() { return `DiscordAPIError[${this.code}]`; }
}

// ───────────────────────────── Helpers ────────────────────────────────────
function emit(ev) { H.send({ op: 'ev', ev }); }
function apiDelay() { return H.delay(H.latencyMs); }
function cdn(route, hash, { extension = 'webp', size, forceStatic = false } = {}) {
  const ext = !forceStatic && String(hash).startsWith('a_') ? 'gif' : extension;
  return `https://cdn.discordapp.com/${route}.${ext}${size ? `?size=${size}` : ''}`;
}
function plain(x) {
  if (x === undefined) return undefined;
  if (x && typeof x.toJSON === 'function') x = x.toJSON();
  return JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
function resolveMessageFlags(flags) {
  if (flags === undefined || flags === null) return 0;
  try { return Number(MessageFlagsBitField.resolve(flags)); } catch { return 0; }
}
function fileDesc(f) {
  if (!f) return null;
  if (typeof f === 'string') return { attachment: f };
  const out = {};
  if (f.name) out.name = f.name;
  if (f.attachment && typeof f.attachment === 'string') out.attachment = f.attachment;
  else if (f.attachment && Buffer.isBuffer(f.attachment)) out.bytes = f.attachment.length;
  if (f.description) out.description = f.description;
  return out;
}
// Reduce message/interaction-response options to their observable content.
function normMessage(options, withEphemeral) {
  if (typeof options === 'string') options = { content: options };
  else if (options === null || options === undefined) options = {};
  else if (options && typeof options === 'object' && options.data && options.target) options = options.data; // MessagePayload-ish
  const out = {};
  if (options.content !== undefined) out.content = options.content === null ? null : String(options.content);
  const flags = resolveMessageFlags(options.flags) | (options.ephemeral ? MessageFlags.Ephemeral : 0);
  if (withEphemeral) out.ephemeral = Boolean(flags & MessageFlags.Ephemeral);
  const other = flags & ~MessageFlags.Ephemeral;
  if (other) out.flags = other;
  if (Array.isArray(options.embeds) && options.embeds.length) out.embeds = options.embeds.map(plain);
  if (Array.isArray(options.components) && options.components.length) out.components = options.components.map(plain);
  if (Array.isArray(options.files) && options.files.length) out.files = options.files.map(fileDesc);
  if (Array.isArray(options.attachments) && options.attachments.length) out.attachments = options.attachments.map(plain);
  if (options.allowedMentions !== undefined) out.allowedMentions = plain(options.allowedMentions);
  if (options.tts) out.tts = true;
  if (options.poll) out.poll = plain(options.poll);
  if (Array.isArray(options.stickers) && options.stickers.length) out.stickers = options.stickers.map(plain);
  if (options.reply) out.reply = plain(options.reply);
  return out;
}
// Discord rejects message content longer than 2000 characters (50035).
function contentTooLong(options) {
  const c = typeof options === 'string' ? options : options && options.content;
  return typeof c === 'string' && [...c].length > 2000;
}
function checkContentLength(n, interaction, options) {
  if (!contentTooLong(options)) return;
  throw interaction._err(n, new DiscordAPIError(50035, 'Invalid Form Body\ncontent[BASE_TYPE_MAX_LENGTH]: Must be 2000 or fewer in length.', 400, 'POST', `/interactions/${interaction.id}`));
}
function worldUser(id) {
  for (const u of Object.values(W.USERS)) if (u.id === id) return u;
  if (W.SELF.id === id) return W.SELF;
  return null;
}
function worldUserName(id) {
  for (const [name, u] of Object.entries(W.USERS)) if (u.id === id) return name;
  return null;
}
function worldGuild(id) {
  for (const [key, g] of Object.entries(W.GUILDS)) if (g.id === id) return { key, g };
  return null;
}
function isMemberOf(guildId, userId) {
  const wg = worldGuild(guildId);
  if (!wg) return false;
  if (userId === W.SELF.id) return true;
  const name = worldUserName(userId);
  return Boolean(name && wg.g.members.includes(name));
}
let snowflakeSeq = 0n;
function nextSnowflake() {
  snowflakeSeq += 1n;
  return String(((BigInt(Date.now()) - 1420070400000n) << 22n) + snowflakeSeq);
}

// ───────────────────────────── Structures ─────────────────────────────────
class Base {
  constructor(client) { Object.defineProperty(this, 'client', { value: client, writable: true, configurable: true }); }
  _clone() {
    const c = Object.create(Object.getPrototypeOf(this));
    Object.assign(c, this);
    Object.defineProperty(c, 'client', { value: this.client, writable: true, configurable: true });
    return c;
  }
  valueOf() { return this.id; }
}

class User extends Base {
  constructor(client, data) { super(client); this.id = data.id; this.bot = Boolean(data.bot); this.system = false; this.flags = null; this._patch(data); }
  _patch(data) {
    this.username = data.username;
    this.globalName = data.globalName ?? null;
    this.discriminator = '0';
    this.avatar = data.avatar ?? null;
    this.banner = undefined;
    this.accentColor = undefined;
    this.avatarDecoration = null;
  }
  get partial() { return false; }
  get tag() { return this.discriminator === '0' ? this.username : `${this.username}#${this.discriminator}`; }
  get displayName() { return this.globalName ?? this.username; }
  get defaultAvatarURL() { return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(this.id) >> 22n) % 6n)}.png`; }
  get createdTimestamp() { return Number(BigInt(this.id) >> 22n) + 1420070400000; }
  get createdAt() { return new Date(this.createdTimestamp); }
  get hexAccentColor() { return null; }
  get dmChannel() { return null; }
  avatarURL(options = {}) { return this.avatar ? cdn(`avatars/${this.id}/${this.avatar}`, this.avatar, options) : null; }
  displayAvatarURL(options) { return this.avatarURL(options) ?? this.defaultAvatarURL; }
  bannerURL() { return this.banner ? cdn(`banners/${this.id}/${this.banner}`, this.banner) : this.banner; }
  avatarDecorationURL() { return null; }
  async createDM() { return new DMChannel(this.client, { id: `dm-${this.id}`, recipientId: this.id }); }
  async send(options) { return (await this.createDM()).send(options); }
  async fetch(force = true) { return this.client.users.fetch(this.id, { force }); }
  equals(user) { return Boolean(user) && this.id === user.id && this.username === user.username && this.avatar === user.avatar; }
  toString() { return `<@${this.id}>`; }
  toJSON() { return { id: this.id, username: this.username, globalName: this.globalName, discriminator: this.discriminator, bot: this.bot, avatar: this.avatar }; }
}

class ClientUser extends User {
  get verified() { return true; }
  get mfaEnabled() { return false; }
  _recordPresence(what, data) { emit({ k: 'discord', what, data: plain(data) }); }
  setPresence(data) { this._recordPresence('setPresence', data); return this; }
  setActivity(name, options = {}) { this._recordPresence('setActivity', typeof name === 'object' ? name : { name, ...options }); return this; }
  setStatus(status) { this._recordPresence('setStatus', status); return this; }
  setAFK(afk) { this._recordPresence('setAFK', afk); return this; }
  async setUsername(username) { this._recordPresence('setUsername', username); return this; }
  async setAvatar() { this._recordPresence('setAvatar', null); return this; }
  async edit(data) { this._recordPresence('editClientUser', data); return this; }
}

class GuildMember extends Base {
  constructor(client, data, guild) {
    super(client);
    Object.defineProperty(this, 'guild', { value: guild, writable: true, configurable: true });
    this.user = data.user;
    this.nickname = data.nick ?? null;
    this.avatar = null;
    this.joinedTimestamp = 1704067200000;
    this.premiumSinceTimestamp = null;
    this.communicationDisabledUntilTimestamp = null;
    this.pending = false;
    this.flags = 0;
    this.roles = { cache: new Collection(), highest: null };
  }
  get id() { return this.user.id; }
  get partial() { return false; }
  get displayName() { return this.nickname ?? this.user.displayName; }
  get joinedAt() { return new Date(this.joinedTimestamp); }
  get permissions() { return new PermissionsBitField(0n); }
  avatarURL() { return null; }
  displayAvatarURL(options) { return this.user.displayAvatarURL(options); }
  isCommunicationDisabled() { return false; }
  async fetch(force = true) { return this.guild.members.fetch({ user: this.id, cache: true, force }); }
  async send(options) { return this.user.send(options); }
  toString() { return `<@${this.user.id}>`; }
  toJSON() { return { guildId: this.guild.id, userId: this.user.id, nickname: this.nickname, displayName: this.displayName }; }
}

class Attachment {
  constructor(data) {
    this.id = data.id;
    this.url = data.url;
    this.proxyURL = data.proxyURL ?? data.url;
    this.name = data.name;
    this.size = data.size;
    this.contentType = data.contentType ?? null;
    this.width = data.width ?? null;
    this.height = data.height ?? null;
    this.description = data.description ?? null;
    this.ephemeral = Boolean(data.ephemeral);
    this.duration = data.duration ?? null;
    this.waveform = null;
    this.flags = 0;
    this.title = null;
  }
  get spoiler() { return String(this.name || '').startsWith('SPOILER_'); }
  toJSON() { return { ...this }; }
}

class Message extends Base {
  constructor(client, data) {
    super(client);
    this.id = data.id; this.channelId = data.channelId; this.guildId = data.guildId ?? null;
    this.content = data.content ?? ''; this.author = data.author ?? null; this.embeds = data.embeds ?? [];
    this.components = []; this.attachments = new Collection(); this.createdTimestamp = Date.now(); this.flags = data.flags ?? 0;
  }
  get channel() { return this.client.channels.cache.get(this.channelId) ?? null; }
  get guild() { return this.client.guilds.cache.get(this.guildId) ?? null; }
  get url() { return `https://discord.com/channels/${this.guildId ?? '@me'}/${this.channelId}/${this.id}`; }
  async react(emoji) { emit({ k: 'discord', what: 'message.react', data: { message: this.id, emoji: String(emoji) } }); return null; }
  async edit(options) { emit({ k: 'chan', ch: this.channelId, edit: true, ...normMessage(options, false) }); return this; }
  async delete() { emit({ k: 'discord', what: 'message.delete', data: { message: this.id } }); return this; }
  async reply(options) { const ch = this.channel; return ch ? ch.send(options) : this; }
  toString() { return this.content; }
}

class BaseChannel extends Base {
  isTextBased() { return true; }
  isDMBased() { return false; }
  isVoiceBased() { return false; }
  isThread() { return false; }
  isThreadOnly() { return false; }
  isSendable() { return true; }
  get partial() { return false; }
  get url() { return `https://discord.com/channels/${this.guildId ?? '@me'}/${this.id}`; }
  toString() { return `<#${this.id}>`; }
  async send(options) {
    const rec = normMessage(options, false);
    const seq = ++H.chanSeq;
    emit({ k: 'chan', seq, ch: this.id, ...rec });
    H.count('api.channel.send');
    return H.op(async () => {
      await apiDelay();
      if (this._deleted) {
        emit({ k: 'chanerr', seq, err: 'DiscordAPIError[10003]' });
        throw new DiscordAPIError(10003, 'Unknown Channel', 404, 'POST', `/channels/${this.id}/messages`);
      }
      if (contentTooLong(options)) {
        emit({ k: 'chanerr', seq, err: 'DiscordAPIError[50035]' });
        throw new DiscordAPIError(50035, 'Invalid Form Body', 400, 'POST', `/channels/${this.id}/messages`);
      }
      return new Message(this.client, { id: nextSnowflake(), channelId: this.id, guildId: this.guildId, content: rec.content, author: this.client.user });
    });
  }
  async sendTyping() { return undefined; }
  async fetch() { return this.client.channels.fetch(this.id, { force: true }); }
  get messages() {
    return { cache: new Collection(), fetch: async () => new Collection() };
  }
}

class TextChannel extends BaseChannel {
  constructor(client, data) {
    super(client);
    this.id = data.id; this.type = ChannelType.GuildText; this.name = data.name;
    this.guildId = data.guildId; this.nsfw = false; this.topic = null; this.lastMessageId = null; this.parentId = null;
  }
  get guild() { return this.client.guilds.cache.get(this.guildId) ?? null; }
  permissionsFor() { return new PermissionsBitField(PermissionsBitField.All); }
}

class DMChannel extends BaseChannel {
  constructor(client, data) {
    super(client);
    this.id = data.id; this.type = ChannelType.DM; this.recipientId = data.recipientId ?? null;
    this.guildId = null; this.lastMessageId = null;
  }
  isDMBased() { return true; }
  get recipient() { return this.client.users.cache.get(this.recipientId) ?? null; }
  async send(options) {
    const rec = normMessage(options, false);
    emit({ k: 'dm', to: this.recipientId, ...rec });
    H.count('api.dm.send');
    return H.op(async () => {
      await apiDelay();
      return new Message(this.client, { id: nextSnowflake(), channelId: this.id, content: rec.content, author: this.client.user });
    });
  }
}

class Guild extends Base {
  constructor(client, data) {
    super(client);
    this.id = data.id; this.name = data.name; this.icon = data.icon ?? null; this.available = true;
    this.ownerId = W.SELF.id; this.memberCount = (data.members || []).length + 1; this.large = false;
    this.preferredLocale = 'fr'; this.features = []; this.description = null; this.banner = null; this.splash = null;
    this.members = new GuildMemberManager(client, this);
    this.channels = { cache: new Collection(), guild: this };
    this.roles = { cache: new Collection(), everyone: null };
    this.emojis = { cache: new Collection() };
  }
  get shardId() { return 0; }
  get joinedTimestamp() { return 1704067200000; }
  get nameAcronym() { return this.name.replace(/'s /g, ' ').replace(/\w+/g, (e) => e[0]).replace(/\s/g, ''); }
  iconURL(options = {}) { return this.icon ? cdn(`icons/${this.id}/${this.icon}`, this.icon, options) : null; }
  bannerURL() { return null; }
  splashURL() { return null; }
  async fetch() { return this; }
  async fetchOwner() { return this.members.fetch(this.ownerId); }
  toString() { return this.name; }
  toJSON() { return { id: this.id, name: this.name, icon: this.icon }; }
}

// ───────────────────────────── Managers ───────────────────────────────────
class UserManager {
  constructor(client) { Object.defineProperty(this, 'client', { value: client }); this.cache = new Collection(); }
  resolveId(user) {
    if (typeof user === 'string') return user;
    if (user instanceof User) return user.id;
    if (user instanceof GuildMember) return user.user.id;
    if (user instanceof Message) return user.author?.id ?? null;
    return null;
  }
  resolve(user) {
    if (user instanceof User) return user;
    if (user instanceof GuildMember) return user.user;
    const id = this.resolveId(user);
    return id ? this.cache.get(id) ?? null : null;
  }
  _add(data, cache = true) {
    const existing = this.cache.get(data.id);
    if (existing) { if (!(existing instanceof ClientUser)) existing._patch(data); return existing; }
    const u = data.id === W.SELF.id ? new ClientUser(this.client, data) : new User(this.client, data);
    if (cache) this.cache.set(u.id, u);
    return u;
  }
  async fetch(user, { cache = true, force = false } = {}) {
    const id = this.resolveId(user);
    H.count('users.fetch');
    if (!force) {
      const existing = this.cache.get(id);
      if (existing && !existing.partial) return existing;
    }
    H.count('api.users.fetch');
    return H.op(async () => {
      await apiDelay();
      const w = worldUser(id);
      if (!w || w.deleted) throw new DiscordAPIError(10013, 'Unknown User', 404, 'GET', `/users/${id}`);
      return this._add(w, cache);
    });
  }
  async createDM(user) { const id = this.resolveId(user); return new DMChannel(this.client, { id: `dm-${id}`, recipientId: id }); }
  async send(user, options) { return (await this.createDM(user)).send(options); }
}

class GuildMemberManager {
  constructor(client, guild) {
    Object.defineProperty(this, 'client', { value: client });
    Object.defineProperty(this, 'guild', { value: guild });
    this.cache = new Collection();
  }
  get me() { return this.cache.get(this.client.user?.id) ?? null; }
  resolveId(member) {
    if (member instanceof GuildMember) return member.user.id;
    return this.client.users.resolveId(member);
  }
  resolve(member) {
    if (member instanceof GuildMember) return member;
    const id = this.resolveId(member);
    return id ? this.cache.get(id) ?? null : null;
  }
  _add(userData, cache = true) {
    const user = userData instanceof User ? userData : this.client.users._add(userData);
    const existing = this.cache.get(user.id);
    if (existing) return existing;
    const m = new GuildMember(this.client, { user }, this.guild);
    if (cache) this.cache.set(user.id, m);
    return m;
  }
  fetch(options) {
    if (!options || (typeof options === 'object' && !Array.isArray(options) && !('user' in options) && !('query' in options))) {
      return this._fetchMany(options ?? {});
    }
    const user = this.client.users.resolveId(options);
    if (user) return this._fetchSingle({ user, cache: true });
    if (options.user) {
      if (Array.isArray(options.user)) {
        return this._fetchMany({ ...options, user: options.user.map((u) => this.client.users.resolveId(u)) });
      }
      const single = { ...options, user: this.client.users.resolveId(options.user) };
      if (!single.limit && !single.withPresences) return this._fetchSingle(single);
      return this._fetchMany({ ...single, user: [single.user] });
    }
    return this._fetchMany(options);
  }
  async _fetchSingle({ user, cache = true, force = false }) {
    H.count('members.fetch');
    if (!force) {
      const existing = this.cache.get(user);
      if (existing && !existing.partial) return existing;
    }
    H.count('api.members.fetch');
    return H.op(async () => {
      await apiDelay();
      const w = worldUser(user);
      if (!w || !isMemberOf(this.guild.id, user)) {
        throw new DiscordAPIError(10007, 'Unknown Member', 404, 'GET', `/guilds/${this.guild.id}/members/${user}`);
      }
      return this._add(w, cache);
    });
  }
  async _fetchMany({ user: ids, query, limit = 0 } = {}) {
    H.count('api.members.fetchMany');
    return H.op(async () => {
      await apiDelay();
      const out = new Collection();
      const wg = worldGuild(this.guild.id);
      const all = wg ? wg.g.members.map((n) => W.USERS[n]).filter(Boolean) : [];
      let found;
      if (Array.isArray(ids)) found = ids.map((id) => all.find((u) => u.id === id)).filter(Boolean);
      else if (typeof query === 'string') found = all.filter((u) => u.username.toLowerCase().startsWith(query.toLowerCase()));
      else found = all;
      if (limit) found = found.slice(0, limit);
      for (const u of found) { const m = this._add(u, true); out.set(m.id, m); }
      return out;
    });
  }
  async search({ query, limit = 1 } = {}) { return this._fetchMany({ query, limit }); }
}

class ChannelManager {
  constructor(client) { Object.defineProperty(this, 'client', { value: client }); this.cache = new Collection(); }
  resolveId(ch) { return typeof ch === 'string' ? ch : ch?.id ?? null; }
  resolve(ch) { const id = this.resolveId(ch); return id ? this.cache.get(id) ?? null : null; }
  async fetch(id, { force = false } = {}) {
    H.count('channels.fetch');
    if (!force) {
      const existing = this.cache.get(id);
      if (existing) return existing;
    }
    H.count('api.channels.fetch');
    return H.op(async () => {
      await apiDelay();
      const ch = H.channelObjects.get(id);
      if (!ch || ch._deleted) throw new DiscordAPIError(10003, 'Unknown Channel', 404, 'GET', `/channels/${id}`);
      this.cache.set(id, ch);
      return ch;
    });
  }
}

class GuildManager {
  constructor(client) { Object.defineProperty(this, 'client', { value: client }); this.cache = new Collection(); }
  resolveId(g) { return typeof g === 'string' ? g : g?.id ?? null; }
  resolve(g) { const id = this.resolveId(g); return id ? this.cache.get(id) ?? null : null; }
  async fetch(id) {
    H.count('guilds.fetch');
    if (typeof id === 'string' && this.cache.has(id)) return this.cache.get(id);
    if (id === undefined || typeof id === 'object') return this.cache.clone();
    H.count('api.guilds.fetch');
    return H.op(async () => {
      await apiDelay();
      throw new DiscordAPIError(10004, 'Unknown Guild', 404, 'GET', `/guilds/${id}`);
    });
  }
}

// ───────────────────────────── Interactions ───────────────────────────────
class CommandInteractionOptionResolver {
  constructor(client, data, resolved) {
    Object.defineProperty(this, 'client', { value: client });
    this.data = data;
    this.resolved = resolved;
    this._group = null;
    this._subcommand = null;
    this._hoistedOptions = data;
    if (data[0]?.type === ApplicationCommandOptionType.SubcommandGroup) {
      this._group = data[0].name;
      this._hoistedOptions = data[0].options ?? [];
    }
    if (this._hoistedOptions[0]?.type === ApplicationCommandOptionType.Subcommand) {
      this._subcommand = this._hoistedOptions[0].name;
      this._hoistedOptions = this._hoistedOptions[0].options ?? [];
    }
  }
  get(name, required = false) {
    const option = this._hoistedOptions.find((opt) => opt.name === name);
    if (!option) {
      if (required) throw new DiscordjsTypeError('CommandInteractionOptionNotFound', name);
      return null;
    }
    return option;
  }
  _getTypedOption(name, allowedTypes, properties, required) {
    const option = this.get(name, required);
    if (!option) return null;
    if (!allowedTypes.includes(option.type)) {
      throw new DiscordjsTypeError('CommandInteractionOptionType', name, option.type, allowedTypes.join(', '));
    }
    if (required && properties.every((p) => option[p] === null || option[p] === undefined)) {
      throw new DiscordjsTypeError('CommandInteractionOptionEmpty', name, option.type);
    }
    return option;
  }
  getSubcommand(required = true) {
    if (required && !this._subcommand) throw new DiscordjsTypeError('CommandInteractionOptionNoSubcommand');
    return this._subcommand;
  }
  getSubcommandGroup(required = false) {
    if (required && !this._group) throw new DiscordjsTypeError('CommandInteractionOptionNoSubcommandGroup');
    return this._group;
  }
  getBoolean(name, required = false) { return this._getTypedOption(name, [5], ['value'], required)?.value ?? null; }
  getChannel(name, required = false) { return this._getTypedOption(name, [7], ['channel'], required)?.channel ?? null; }
  getString(name, required = false) { return this._getTypedOption(name, [3], ['value'], required)?.value ?? null; }
  getInteger(name, required = false) { return this._getTypedOption(name, [4], ['value'], required)?.value ?? null; }
  getNumber(name, required = false) { return this._getTypedOption(name, [10], ['value'], required)?.value ?? null; }
  getUser(name, required = false) { return this._getTypedOption(name, [6, 9], ['user'], required)?.user ?? null; }
  getMember(name) { return this._getTypedOption(name, [6, 9], ['member'], false)?.member ?? null; }
  getRole(name, required = false) { return this._getTypedOption(name, [8, 9], ['role'], required)?.role ?? null; }
  getMentionable(name, required = false) {
    const o = this._getTypedOption(name, [9], ['user', 'member', 'role'], required);
    return o?.member ?? o?.user ?? o?.role ?? null;
  }
  getAttachment(name, required = false) { return this._getTypedOption(name, [11], ['attachment'], required)?.attachment ?? null; }
  getFocused() { throw new DiscordjsTypeError('AutocompleteInteractionOptionNoFocusedOption'); }
}

class InteractionResponse {
  constructor(interaction, id) { this.interaction = interaction; this.client = interaction.client; this.id = id ?? interaction.id; }
  async fetch() { return this.interaction.fetchReply(); }
  async edit(options) { return this.interaction.editReply(options); }
  async delete() { return this.interaction.deleteReply(); }
  createMessageComponentCollector() { const e = new EventEmitter(); e.stop = () => {}; return e; }
  awaitMessageComponent() { return new Promise(() => {}); }
}

class BaseInteraction extends Base {
  constructor(client, spec) {
    super(client);
    this.id = spec.iid;
    this.applicationId = W.SELF.id;
    this.token = `itoken-${spec.iid}`;
    this.version = 1;
    this.guildId = spec.guildId ?? null;
    this.channelId = spec.channelId ?? null;
    const wu = worldUser(spec.userId);
    this.user = client.users._add(wu);
    const guild = this.guildId ? client.guilds.cache.get(this.guildId) : null;
    this.member = this.guildId ? (guild ? guild.members._add(this.user) : { user: this.user }) : null;
    this.locale = 'fr';
    this.guildLocale = this.guildId ? 'fr' : null;
    this.appPermissions = new PermissionsBitField(PermissionsBitField.All);
    this.memberPermissions = this.guildId ? new PermissionsBitField(0n) : null;
    this.entitlements = new Collection();
    this.context = this.guildId ? InteractionContextType.Guild : InteractionContextType.BotDM;
    this.authorizingIntegrationOwners = { 0: this.guildId ?? undefined };
    this.createdTimestamp = Date.now();
    this.deferred = false;
    this.replied = false;
    this.ephemeral = null;
    this.webhook = { id: this.applicationId };
    this._acked = false;
    this._expired = Boolean(spec.expired);
    this._n = 0;
  }
  get createdAt() { return new Date(this.createdTimestamp); }
  get guild() { return this.guildId ? this.client.guilds.cache.get(this.guildId) ?? null : null; }
  get channel() { return this.channelId ? (this.client.channels.cache.get(this.channelId) ?? H.channelObjects.get(this.channelId) ?? null) : null; }
  inGuild() { return Boolean(this.guildId && this.member); }
  inCachedGuild() { return Boolean(this.guild && this.member); }
  inRawGuild() { return Boolean(this.guildId && !this.guild && this.member); }
  isAnySelectMenu() { return false; }
  isAutocomplete() { return false; }
  isButton() { return false; }
  isChannelSelectMenu() { return false; }
  isChatInputCommand() { return false; }
  isCommand() { return false; }
  isContextMenuCommand() { return false; }
  isMentionableSelectMenu() { return false; }
  isMessageComponent() { return false; }
  isMessageContextMenuCommand() { return false; }
  isModalSubmit() { return false; }
  isPrimaryEntryPointCommand() { return false; }
  isRepliable() { return true; }
  isRoleSelectMenu() { return false; }
  isSelectMenu() { return false; }
  isStringSelectMenu() { return false; }
  isUserContextMenuCommand() { return false; }
  isUserSelectMenu() { return false; }

  _rec(m, a) {
    const n = ++this._n;
    emit({ k: 'ix', iid: this.id, n, m, a });
    return n;
  }
  _err(n, error) {
    emit({ k: 'ixerr', iid: this.id, n, err: error.name, msg: error.message });
    return error;
  }
  async _ack(m, options) {
    const n = this._rec(m, normMessage(options, true));
    if (this.deferred || this.replied) throw this._err(n, new DiscordjsError('InteractionAlreadyReplied'));
    const already = this._acked;
    this._acked = true;
    H.count(`api.interaction.${m}`);
    return H.op(async () => {
      await apiDelay();
      if (already) throw this._err(n, new DiscordAPIError(40060, 'Interaction has already been acknowledged.', 400, 'POST', `/interactions/${this.id}/${this.token}/callback`));
      try {
        if (this._expired) throw this._err(n, new DiscordAPIError(10062, 'Unknown interaction', 404, 'POST', `/interactions/${this.id}/${this.token}/callback`));
        checkContentLength(n, this, options);
      } catch (e) {
        this._acked = false; // a rejected callback does not acknowledge the interaction
        throw e;
      }
      const flags = resolveMessageFlags(options?.flags) | (options?.ephemeral ? MessageFlags.Ephemeral : 0);
      this.ephemeral = Boolean(flags & MessageFlags.Ephemeral);
      if (m === 'deferReply') this.deferred = true; else this.replied = true;
      if (options && (options.fetchReply || options.withResponse)) {
        const msg = new Message(this.client, { id: nextSnowflake(), channelId: this.channelId, guildId: this.guildId, content: normMessage(options, false).content, author: this.client.user, flags });
        return options.withResponse ? { interaction: this, resource: { message: msg } } : msg;
      }
      return new InteractionResponse(this);
    });
  }
  deferReply(options = {}) { return this._ack('deferReply', options); }
  reply(options) { return this._ack('reply', options); }
  async editReply(options) {
    const n = this._rec('editReply', normMessage(options, false));
    if (!this.deferred && !this.replied) throw this._err(n, new DiscordjsError('InteractionNotReplied'));
    H.count('api.interaction.editReply');
    return H.op(async () => {
      await apiDelay();
      checkContentLength(n, this, options);
      this.replied = true;
      return new Message(this.client, { id: nextSnowflake(), channelId: this.channelId, guildId: this.guildId, content: normMessage(options, false).content, author: this.client.user });
    });
  }
  async followUp(options) {
    const n = this._rec('followUp', normMessage(options, true));
    if (!this.deferred && !this.replied) throw this._err(n, new DiscordjsError('InteractionNotReplied'));
    H.count('api.interaction.followUp');
    return H.op(async () => {
      await apiDelay();
      checkContentLength(n, this, options);
      return new Message(this.client, { id: nextSnowflake(), channelId: this.channelId, guildId: this.guildId, content: normMessage(options, false).content, author: this.client.user });
    });
  }
  async deleteReply(message = '@original') {
    const n = this._rec('deleteReply', { message: String(message) });
    if (this.ephemeral) throw this._err(n, new DiscordjsError('InteractionEphemeralReplied'));
    H.count('api.interaction.deleteReply');
    return H.op(async () => { await apiDelay(); });
  }
  async fetchReply() {
    H.count('api.interaction.fetchReply');
    return H.op(async () => {
      await apiDelay();
      return new Message(this.client, { id: nextSnowflake(), channelId: this.channelId, guildId: this.guildId, content: '', author: this.client.user });
    });
  }
  async showModal(modal) {
    const n = this._rec('showModal', { modal: plain(modal) });
    if (this.deferred || this.replied) throw this._err(n, new DiscordjsError('InteractionAlreadyReplied'));
    this._acked = true;
    return H.op(async () => { await apiDelay(); });
  }
  async deferUpdate(options = {}) { return this._ack('deferUpdate', options); }
  async update(options) { return this._ack('update', options); }
}

class ChatInputCommandInteraction extends BaseInteraction {
  constructor(client, spec) {
    super(client, spec);
    this.type = InteractionType.ApplicationCommand;
    this.commandType = ApplicationCommandType.ChatInput;
    this.commandName = spec.commandName;
    this.commandId = '400000000000000001';
    this.commandGuildId = null;
    const guild = this.guild;
    const resolved = { users: new Collection(), members: new Collection(), attachments: new Collection(), channels: new Collection(), roles: new Collection() };
    const transform = (o) => {
      const out = { name: o.name, type: o.type };
      if (o.type === ApplicationCommandOptionType.User) {
        const wu = worldUser(o.value);
        out.value = o.value;
        if (wu) {
          out.user = client.users._add(wu);
          resolved.users.set(out.user.id, out.user);
          if (guild && isMemberOf(guild.id, wu.id)) {
            out.member = guild.members._add(out.user);
            resolved.members.set(out.user.id, out.member);
          }
        }
      } else if (o.type === ApplicationCommandOptionType.Attachment) {
        out.value = o.attachment.id;
        out.attachment = new Attachment(o.attachment);
        resolved.attachments.set(out.attachment.id, out.attachment);
      } else {
        out.value = o.value;
      }
      return out;
    };
    let data = (spec.options || []).map(transform);
    if (spec.subcommand) data = [{ name: spec.subcommand, type: ApplicationCommandOptionType.Subcommand, options: data }];
    if (spec.subcommandGroup) data = [{ name: spec.subcommandGroup, type: ApplicationCommandOptionType.SubcommandGroup, options: data }];
    this.options = new CommandInteractionOptionResolver(client, data, resolved);
  }
  isChatInputCommand() { return true; }
  isCommand() { return true; }
  toString() {
    const sub = this.options.getSubcommand(false);
    return `/${this.commandName}${sub ? ` ${sub}` : ''}`;
  }
}

class ButtonInteraction extends BaseInteraction {
  constructor(client, spec) {
    super(client, spec);
    this.type = InteractionType.MessageComponent;
    this.componentType = ComponentType.Button;
    this.customId = spec.customId ?? 'button';
    this.message = null;
  }
  isButton() { return true; }
  isMessageComponent() { return true; }
}

// ───────────────────────────── Client ─────────────────────────────────────
function intentNames(intents) {
  let bits = 0;
  try { bits = Number(IntentsBitField.resolve(intents ?? 0)); } catch { bits = -1; }
  if (bits < 0) return ['<unresolvable>'];
  return Object.entries(GatewayIntentBits)
    .filter(([name, bit]) => (bits & bit) === bit && !['GuildBans', 'GuildEmojisAndStickers'].includes(name))
    .map(([name]) => name)
    .sort();
}

class ClientApplication {
  constructor(client) {
    Object.defineProperty(this, 'client', { value: client });
    this.id = W.SELF.id;
    const rec = (what) => async (...args) => { emit({ k: 'discord', what: `application.commands.${what}`, data: plain(args.map((a) => (Array.isArray(a) ? a.map((c) => c?.name ?? plain(c)) : a))) }); return new Collection(); };
    this.commands = { set: rec('set'), create: rec('create'), edit: rec('edit'), delete: rec('delete'), fetch: async () => new Collection(), cache: new Collection() };
  }
  async fetch() { return this; }
}

class Client extends EventEmitter {
  constructor(options = {}) {
    // Like discord.js v14's BaseClient: a rejected promise returned by an
    // async listener is re-emitted as 'error' on the client (and crashes the
    // process if nobody listens to 'error').
    super({ captureRejections: true });
    this.options = options;
    this.user = null;
    this.application = null;
    this.token = null;
    this.readyTimestamp = null;
    this.users = new UserManager(this);
    this.guilds = new GuildManager(this);
    this.channels = new ChannelManager(this);
    this.ws = { ping: 42, status: 0, shards: new Collection() };
    this.rest = new REST();
    this.shard = null;
    this.sweepers = { sweepUsers() {}, sweepGuildMembers() {} };
    H.clients.push(this);
    emit({
      k: 'discord', what: 'new Client',
      data: { intents: intentNames(options.intents), partials: Array.isArray(options.partials) ? options.partials.map((p) => Object.keys(Partials).find((k) => Partials[k] === p) ?? p).sort() : [] },
    });
  }
  get readyAt() { return this.readyTimestamp ? new Date(this.readyTimestamp) : null; }
  get uptime() { return this.readyTimestamp ? Date.now() - this.readyTimestamp : null; }
  isReady() { return this.readyTimestamp !== null; }
  _populate() {
    this.user = this.users._add(W.SELF);
    this.application = new ClientApplication(this);
    for (const g of Object.values(W.GUILDS)) {
      const guild = new Guild(this, g);
      this.guilds.cache.set(guild.id, guild);
      guild.members._add(this.user);
    }
    for (const [key, c] of Object.entries(W.CHANNELS)) {
      if (c.dm) continue;
      const guildId = W.GUILDS[c.guild].id;
      let ch = H.channelObjects.get(c.id);
      if (!ch) {
        ch = new TextChannel(this, { id: c.id, name: c.name, guildId });
        H.channelObjects.set(c.id, ch);
      } else ch.client = this;
      ch._worldKey = key;
      if (!ch._deleted) {
        this.channels.cache.set(ch.id, ch);
        this.guilds.cache.get(guildId)?.channels.cache.set(ch.id, ch);
      }
    }
  }
  async login(token = process.env.DISCORD_TOKEN) {
    H.count('client.login');
    if (!token || typeof token !== 'string') throw new DiscordjsError('TokenInvalid');
    this.token = token;
    this._populate();
    emit({ k: 'discord', what: 'login' });
    H.send({ op: 'login' });
    H.realSetTimeout(() => {
      this.readyTimestamp = Date.now();
      this.emit('ready', this);
      this.emit('clientReady', this);
    }, H.latencyMs);
    return token;
  }
  async destroy() {
    H.count('client.destroy');
    emit({ k: 'discord', what: 'destroy' });
    this.readyTimestamp = null;
    this.token = null;
  }
  async fetchInvite() { return null; }
  async fetchWebhook() { return null; }
  async fetchGuildPreview() { return null; }
  generateInvite() { return `https://discord.com/oauth2/authorize?client_id=${W.SELF.id}`; }
  toJSON() { return { user: this.user?.id ?? null }; }
}

// ───────────────────────────── REST / builders ────────────────────────────
class REST {
  constructor(options = {}) { this.options = options; this.token = null; }
  setToken(token) { this.token = token; return this; }
  async _rec(method, route, opts = {}) {
    emit({ k: 'discord', what: `rest.${method}`, data: { route: String(route), body: Array.isArray(opts.body) ? opts.body.map((c) => c?.name ?? plain(c)) : plain(opts.body) } });
    return Array.isArray(opts.body) ? opts.body : {};
  }
  get(route, opts) { return this._rec('get', route, opts); }
  put(route, opts) { return this._rec('put', route, opts); }
  post(route, opts) { return this._rec('post', route, opts); }
  patch(route, opts) { return this._rec('patch', route, opts); }
  delete(route, opts) { return this._rec('delete', route, opts); }
}
const Routes = new Proxy({
  applicationCommands: (app) => `/applications/${app}/commands`,
  applicationGuildCommands: (app, guild) => `/applications/${app}/guilds/${guild}/commands`,
  channelMessages: (ch) => `/channels/${ch}/messages`,
  user: (id = '@me') => `/users/${id}`,
}, { get: (t, k) => t[k] ?? ((...a) => `/${String(k)}/${a.join('/')}`) });

// Generic chainable builder: setX(v) stores data.x, add*(...) appends.
function makeBuilderClass(name, extra = {}) {
  const C = class {
    constructor(data = {}) {
      this.data = { ...data };
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target || typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
          if (typeof prop !== 'string') return undefined;
          if (prop.startsWith('set')) {
            const key = prop[3].toLowerCase() + prop.slice(4);
            return (v) => { target.data[key] = v; return receiver; };
          }
          if (prop.startsWith('add') || prop.startsWith('spliceFields')) {
            return (...args) => {
              const key = prop === 'addFields' ? 'fields' : prop === 'addComponents' ? 'components' : prop === 'addChoices' ? 'choices' : 'options';
              const arr = target.data[key] ||= [];
              for (const a of args.flat()) {
                if (typeof a === 'function') { const sub = new GenericBuilder(); a(sub); arr.push(sub.toJSON()); }
                else arr.push(a && typeof a.toJSON === 'function' ? a.toJSON() : a);
              }
              return receiver;
            };
          }
          return undefined;
        },
      });
    }
    toJSON() { return plain(this.data); }
  };
  Object.defineProperty(C, 'name', { value: name });
  Object.assign(C.prototype, extra);
  return C;
}
const GenericBuilder = makeBuilderClass('GenericBuilder');
const EmbedBuilder = makeBuilderClass('EmbedBuilder', {
  setTimestamp(ts = Date.now()) { this.data.timestamp = new Date(ts instanceof Date ? ts.getTime() : ts).toISOString(); return this; },
});
const SlashCommandBuilder = makeBuilderClass('SlashCommandBuilder');
const ContextMenuCommandBuilder = makeBuilderClass('ContextMenuCommandBuilder');
const ActionRowBuilder = makeBuilderClass('ActionRowBuilder');
const ButtonBuilder = makeBuilderClass('ButtonBuilder');
const StringSelectMenuBuilder = makeBuilderClass('StringSelectMenuBuilder');
const ModalBuilder = makeBuilderClass('ModalBuilder');
const TextInputBuilder = makeBuilderClass('TextInputBuilder');
class AttachmentBuilder {
  constructor(attachment, data = {}) { this.attachment = attachment; this.name = data.name; this.description = data.description; }
  setName(n) { this.name = n; return this; }
  setDescription(d) { this.description = d; return this; }
  setFile(a) { this.attachment = a; return this; }
  toJSON() { return { name: this.name, description: this.description }; }
}

// ───────────────────────────── Formatters ─────────────────────────────────
const userMention = (id) => `<@${id}>`;
const channelMention = (id) => `<#${id}>`;
const roleMention = (id) => `<@&${id}>`;
const bold = (s) => `**${s}**`;
const italic = (s) => `_${s}_`;
const underline = (s) => `__${s}__`;
const strikethrough = (s) => `~~${s}~~`;
const spoiler = (s) => `||${s}||`;
const quote = (s) => `> ${s}`;
const blockQuote = (s) => `>>> ${s}`;
const inlineCode = (s) => `\`${s}\``;
const codeBlock = (lang, s) => (s === undefined ? `\`\`\`\n${lang}\n\`\`\`` : `\`\`\`${lang}\n${s}\n\`\`\``);
const hyperlink = (text, url, title) => (title ? `[${text}](${url} "${title}")` : `[${text}](${url})`);
const hideLinkEmbed = (url) => `<${url}>`;
const formatEmoji = (id, animated = false) => `<${animated ? 'a' : ''}:_:${id}>`;
const time = (t, style) => {
  const secs = t instanceof Date ? Math.floor(t.getTime() / 1000) : (t ?? Math.floor(Date.now() / 1000));
  return style ? `<t:${secs}:${style}>` : `<t:${secs}>`;
};
const escapeMarkdown = (s) => String(s).replace(/([*_`~|\\>])/g, '\\$1');

// ───────────────────────────── Harness hooks ──────────────────────────────
function currentClient() { return H.clients[H.clients.length - 1] || null; }

H.discord = {
  dispatchInteraction(spec) {
    const client = currentClient();
    if (!client) { emit({ k: 'note', note: 'interaction dropped: no discord client' }); return; }
    const ix = spec.kind === 'button' ? new ButtonInteraction(client, spec) : new ChatInputCommandInteraction(client, spec);
    client.emit(Events.InteractionCreate, ix);
  },
  guildUpdate(guildId, patch) {
    const client = currentClient();
    const guild = client?.guilds.cache.get(guildId);
    if (!guild) return;
    const old = guild._clone();
    Object.assign(guild, patch);
    const wg = worldGuild(guildId);
    if (wg) Object.assign(wg.g, patch);
    client.emit(Events.GuildUpdate, old, guild);
  },
  deleteChannel(channelId) {
    const client = currentClient();
    const ch = H.channelObjects.get(channelId);
    if (!ch) return;
    ch._deleted = true;
    if (client) {
      client.channels.cache.delete(channelId);
      client.guilds.cache.get(ch.guildId)?.channels.cache.delete(channelId);
      client.emit(Events.ChannelDelete, ch);
    }
  },
  memberLeave(guildKey, userName) {
    const g = W.GUILDS[guildKey];
    if (g) g.members = g.members.filter((n) => n !== userName);
  },
  deleteUser(userName) {
    if (W.USERS[userName]) W.USERS[userName].deleted = true;
  },
};

module.exports = {
  Client, Collection, BitField, IntentsBitField, MessageFlagsBitField, PermissionsBitField,
  GatewayIntentBits, Partials, Events, MessageFlags, ChannelType, InteractionType, ApplicationCommandType,
  ApplicationCommandOptionType, InteractionContextType, ApplicationIntegrationType, ActivityType, PresenceUpdateStatus,
  ButtonStyle, ComponentType, TextInputStyle, Colors, PermissionFlagsBits, TimestampStyles, RESTJSONErrorCodes,
  DiscordjsError, DiscordjsTypeError, DiscordjsRangeError, DiscordjsErrorCodes, DiscordAPIError,
  User, ClientUser, GuildMember, Guild, TextChannel, DMChannel, BaseChannel, Message, Attachment,
  BaseInteraction, ChatInputCommandInteraction, ButtonInteraction, CommandInteractionOptionResolver, InteractionResponse,
  UserManager, GuildMemberManager, ChannelManager, GuildManager,
  REST, Routes, EmbedBuilder, SlashCommandBuilder, ContextMenuCommandBuilder, ActionRowBuilder, ButtonBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, AttachmentBuilder,
  userMention, channelMention, roleMention, bold, italic, underline, strikethrough, spoiler, quote, blockQuote,
  inlineCode, codeBlock, hyperlink, hideLinkEmbed, formatEmoji, time, escapeMarkdown,
  version: '14.99.0-harness',
};
