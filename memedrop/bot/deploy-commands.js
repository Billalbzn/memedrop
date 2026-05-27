// deploy-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // /drop @target [@target2...] media [caption]
  // discord doesn't natively support multi-user pickers, so we expose 5 optional
  // target slots: target, target2, target3, target4, target5.
  // alternatively the user can put @mentions inside `caption` and bot parses them.
  (() => {
    const b = new SlashCommandBuilder()
      .setName('drop')
      .setDescription('Drop a meme on one or more people')
      .addUserOption(o => o.setName('target')
        .setDescription('Who gets it (use target2..5 for more)')
        .setRequired(true))
      .addAttachmentOption(o => o.setName('media')
        .setDescription('Image, GIF, or video')
        .setRequired(true))
      .addStringOption(o => o.setName('caption')
        .setDescription('Optional text to display with the meme')
        .setMaxLength(80)
        .setRequired(false));
    for (let i = 2; i <= 5; i++) {
      b.addUserOption(o => o.setName(`target${i}`)
        .setDescription(`Additional target ${i}`)
        .setRequired(false));
    }
    return b.toJSON();
  })(),

  // /dropall — drop on every linked overlay in this server
  new SlashCommandBuilder()
    .setName('dropall')
    .setDescription('Drop a meme on everyone with a linked overlay in this server')
    .addAttachmentOption(o => o.setName('media')
      .setDescription('Image, GIF, or video')
      .setRequired(true))
    .addStringOption(o => o.setName('caption')
      .setDescription('Optional text to display with the meme')
      .setMaxLength(80)
      .setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link this Discord account to a running overlay')
    .addStringOption(o => o.setName('code')
      .setDescription('6-digit code shown in the overlay app')
      .setRequired(true)
      .setMinLength(6)
      .setMaxLength(6))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your Discord from the overlay')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check if your overlay is connected')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('who')
    .setDescription('See who in this server has a linked overlay (potential targets)')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const devGuilds = (process.env.DEV_GUILD_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (devGuilds.length) {
      for (const guildId of devGuilds) {
        await rest.put(
          Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
          { body: commands },
        );
        console.log(`✓ Registered ${commands.length} commands on guild ${guildId}`);
      }
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log(`✓ Registered ${commands.length} global commands (may take up to 1h to propagate)`);
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
