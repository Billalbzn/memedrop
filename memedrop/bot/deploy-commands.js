// deploy-commands.js
// Run once after changing slash command definitions: `node deploy-commands.js`
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('drop')
    .setDescription('Drop a meme onto someone\'s overlay')
    .addUserOption(o =>
      o.setName('target')
        .setDescription('Who gets the meme dropped on their screen')
        .setRequired(true))
    .addAttachmentOption(o =>
      o.setName('media')
        .setDescription('Image, GIF, or video to drop')
        .setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link this Discord account to a running overlay')
    .addStringOption(o =>
      o.setName('code')
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
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

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
