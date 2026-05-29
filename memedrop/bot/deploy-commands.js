// deploy-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // /drop @cible media [musique] [caption]
  // Discord ne supporte pas nativement les sélecteurs multi-utilisateurs,
  // on expose donc 5 slots optionnels : target, target2…target5.
  (() => {
    const b = new SlashCommandBuilder()
      .setName('drop')
      .setDescription('Envoie un mème sur l\'écran d\'une ou plusieurs personnes')
      .addUserOption(o => o.setName('target')
        .setDescription('Qui reçoit le drop (utilise target2..5 pour en ajouter)')
        .setRequired(true))
      .addAttachmentOption(o => o.setName('media')
        .setDescription('Image, GIF ou vidéo à afficher')
        .setRequired(true))
      .addStringOption(o => o.setName('caption')
        .setDescription('Texte affiché en surimpression (80 caractères max.)')
        .setMaxLength(80)
        .setRequired(false))
      .addAttachmentOption(o => o.setName('musique')
        .setDescription('MP3 à jouer en même temps que la photo (optionnel)')
        .setRequired(false));
    for (let i = 2; i <= 5; i++) {
      b.addUserOption(o => o.setName(`target${i}`)
        .setDescription(`Cible supplémentaire ${i}`)
        .setRequired(false));
    }
    return b.toJSON();
  })(),

  // /dropall — envoie à tous les overlays liés de ce serveur
  new SlashCommandBuilder()
    .setName('dropall')
    .setDescription('Envoie un mème à tout le monde ayant un overlay lié sur ce serveur')
    .addAttachmentOption(o => o.setName('media')
      .setDescription('Image, GIF ou vidéo à afficher')
      .setRequired(true))
    .addStringOption(o => o.setName('caption')
      .setDescription('Texte affiché en surimpression (80 caractères max.)')
      .setMaxLength(80)
      .setRequired(false))
    .addAttachmentOption(o => o.setName('musique')
      .setDescription('MP3 à jouer en même temps que la photo (optionnel)')
      .setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Associe ce compte Discord à un overlay MemeDrop actif')
    .addStringOption(o => o.setName('code')
      .setDescription('Code à 6 chiffres affiché dans l\'application overlay')
      .setRequired(true)
      .setMinLength(6)
      .setMaxLength(6))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Dissocie ton compte Discord de l\'overlay')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Vérifie si ton overlay est connecté')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('who')
    .setDescription('Voir qui sur ce serveur a un overlay lié (cibles potentielles)')
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
        console.log(`✓ ${commands.length} commandes enregistrées sur le serveur ${guildId}`);
      }
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log(`✓ ${commands.length} commandes globales enregistrées (propagation jusqu'à 1h)`);
    }
  } catch (err) {
    console.error('Échec de l\'enregistrement des commandes :', err);
    process.exit(1);
  }
})();
