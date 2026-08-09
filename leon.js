// ============================================================================
//  Leon — Pokémon GO Event Role Sign-Up Bot
//  discord.js v14
//
//  Assumes the channel Leon posts to is only visible to Ambassadors + Admins
//  (server-level channel permissions), so no extra permission check is
//  needed for four of the five roles — everyone who can see/react to the
//  card already qualifies. Rewarded Host is the one exception: it must
//  exclude Admins even though they share the channel.
//
//  Flow:
//   1. An Ambassador runs /event (title, date, timing).
//   2. Leon posts an embed with five blank role slots, in this order:
//        🎁 Rewarded Host   -> Ambassadors ONLY (Admins excluded)
//        🏆 Rewarder        -> anyone who can see the channel
//        🕺 Mover/Shaker    -> anyone who can see the channel
//        📸 Documenter      -> anyone who can see the channel
//        🛡️ Guardian        -> anyone who can see the channel
//      and reacts with those five emoji, in that order.
//   3. Only those five reactions are allowed on the card — any other emoji
//      reaction (from anyone) gets stripped immediately.
//   4. Reacting adds your name to that slot (every slot allows multiple
//      people); removing your reaction takes your name back out.
//   5. Right-clicking the card -> Apps -> "Update Timing" lets the event's
//      Rewarded Host change the timing. If no Rewarded Host has signed up
//      yet, the Rewarder can change it instead. If both are present, only
//      the Rewarded Host can.
//
//  Event state lives in data/events.json, keyed by message ID, so sign-ups
//  survive bot restarts.
//
//  Required .env:
//    DISCORD_TOKEN
//    GUILD_ID
//    AMBASSADOR_ROLE_ID
// ============================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

// ----------------------------------------------------------------------------
//  Config
// ----------------------------------------------------------------------------
const CONFIG = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  ambassadorRoleId: process.env.AMBASSADOR_ROLE_ID,
  embedColor: 0xffcb05, // Pokémon-yellow accent
};

for (const [key, val] of Object.entries({
  DISCORD_TOKEN: CONFIG.token,
  GUILD_ID: CONFIG.guildId,
  AMBASSADOR_ROLE_ID: CONFIG.ambassadorRoleId,
})) {
  if (!val) {
    console.error(`Missing required env var: ${key}. Check your .env file.`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
//  Roles <-> emoji (insertion order = reaction order = display order)
// ----------------------------------------------------------------------------
const EMOJI = {
  rewardedHost: '🎁',
  rewarder: '🏆',
  moversShakers: '🕺',
  documenter: '📸',
  guardian: '🛡️',
};
const EMOJI_TO_ROLE = Object.fromEntries(Object.entries(EMOJI).map(([k, v]) => [v, k]));

const ROLE_LABELS = {
  rewardedHost: 'Rewarded Host(s)',
  rewarder: 'Rewarder(s)',
  moversShakers: 'Mover(s) and Shaker(s)',
  documenter: 'Documenter(s)',
  guardian: 'Guardian(s)',
};

// ----------------------------------------------------------------------------
//  Persistent store: messageId -> { title, date, timing, roles: { <role>: [userId,...] } }
// ----------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'events.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
function getEvent(messageId) {
  return loadStore()[messageId] || null;
}
function saveEvent(messageId, record) {
  const store = loadStore();
  store[messageId] = record;
  saveStore(store);
}

function blankRoles() {
  return {
    rewardedHost: [],
    rewarder: [],
    moversShakers: [],
    documenter: [],
    guardian: [],
  };
}

// ----------------------------------------------------------------------------
//  Embed rendering
// ----------------------------------------------------------------------------
function renderEmbed(record) {
  const roleFields = Object.keys(EMOJI).map((role) => {
    const ids = record.roles[role];
    // "Open" instead of underscores — a run of underscores gets parsed by
    // Discord as underline/italic markdown and mangles the whole card.
    const value = ids.length ? ids.map((id) => `<@${id}>`).join(', ') : 'Open';
    return { name: `${EMOJI[role]} ${ROLE_LABELS[role]}`, value, inline: false };
  });

  return new EmbedBuilder()
    .setColor(CONFIG.embedColor)
    .setTitle(record.title)
    .addFields(
      { name: 'Date', value: record.date, inline: true },
      { name: 'Timing', value: record.timing, inline: true },
      ...roleFields
    )
    .setFooter({ text: 'React below to sign up for a role!' });
}

// ----------------------------------------------------------------------------
//  Client
// ----------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('event')
      .setDescription('Post a Pokémon GO event sign-up card.')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Event title').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('date').setDescription('Event date (e.g. Saturday, Aug 16)').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('timing')
          .setDescription('Event timing — can be flexible (e.g. "Afternoon, exact time TBD")')
          .setRequired(true)
      ),
    new ContextMenuCommandBuilder()
      .setName('Update Timing')
      .setType(ApplicationCommandType.Message),
  ];

  try {
    const guild = await c.guilds.fetch(CONFIG.guildId);
    await guild.commands.set(commands.map((cmd) => cmd.toJSON()));
    console.log('Registered /event and "Update Timing" for guild', CONFIG.guildId);
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// ----------------------------------------------------------------------------
//  Interaction router
// ----------------------------------------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'event') {
      return handleEventCommand(interaction);
    }
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Update Timing') {
      return handleUpdateTimingMenu(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('leon:timingModal:')) {
      return handleTimingModalSubmit(interaction);
    }
  } catch (err) {
    console.error('Interaction handler error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction
        .reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

// ----------------------------------------------------------------------------
//  /event -> only Ambassadors may run it
// ----------------------------------------------------------------------------
async function handleEventCommand(interaction) {
  if (!interaction.inGuild()) return;

  if (!interaction.member.roles.cache.has(CONFIG.ambassadorRoleId)) {
    return interaction.reply({
      content: 'Only Ambassadors can post an event card.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const title = interaction.options.getString('title').trim();
  const date = interaction.options.getString('date').trim();
  const timing = interaction.options.getString('timing').trim();

  const record = { title, date, timing, roles: blankRoles() };
  const embed = renderEmbed(record);

  await interaction.reply({ content: 'Posting event card…', flags: MessageFlags.Ephemeral });
  const posted = await interaction.channel.send({ embeds: [embed] });

  saveEvent(posted.id, record);

  for (const emoji of Object.values(EMOJI)) {
    await posted.react(emoji);
  }
}

// ----------------------------------------------------------------------------
//  Right-click a card -> "Update Timing"
// ----------------------------------------------------------------------------
async function handleUpdateTimingMenu(interaction) {
  const message = interaction.targetMessage;
  const record = getEvent(message.id);

  if (!record) {
    return interaction.reply({
      content: 'That message isn’t a Leon event card.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const { allowed, reasonIfNot } = canEditTiming(record, interaction.user.id);
  if (!allowed) {
    return interaction.reply({ content: reasonIfNot, flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`leon:timingModal:${message.id}`)
    .setTitle('Update Event Timing');

  const timingInput = new TextInputBuilder()
    .setCustomId('timing')
    .setLabel('New timing')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200)
    .setValue(record.timing)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(timingInput));
  await interaction.showModal(modal);
}

async function handleTimingModalSubmit(interaction) {
  const messageId = interaction.customId.split(':')[2];
  const record = getEvent(messageId);

  if (!record) {
    return interaction.reply({
      content: 'Couldn’t find that event anymore — it may have been deleted.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Re-check permission at submit time too, in case sign-ups changed
  // between opening the popup and submitting it.
  const { allowed, reasonIfNot } = canEditTiming(record, interaction.user.id);
  if (!allowed) {
    return interaction.reply({ content: reasonIfNot, flags: MessageFlags.Ephemeral });
  }

  record.timing = interaction.fields.getTextInputValue('timing').trim();
  saveEvent(messageId, record);

  const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (msg) {
    await msg.edit({ embeds: [renderEmbed(record)] }).catch(() => {});
  }

  await interaction.reply({ content: 'Timing updated. ✅', flags: MessageFlags.Ephemeral });
}

// Rewarded Host can always edit timing if any are signed up.
// If no Rewarded Host yet, the Rewarder can. If both exist, Rewarded Host wins.
function canEditTiming(record, userId) {
  const hosts = record.roles.rewardedHost;
  const rewarders = record.roles.rewarder;

  if (hosts.length > 0) {
    return hosts.includes(userId)
      ? { allowed: true }
      : { allowed: false, reasonIfNot: 'Only this event’s Rewarded Host can update the timing.' };
  }

  if (rewarders.length > 0) {
    return rewarders.includes(userId)
      ? { allowed: true }
      : {
          allowed: false,
          reasonIfNot: 'No Rewarded Host has signed up yet, so only the Rewarder can update the timing.',
        };
  }

  return {
    allowed: false,
    reasonIfNot: 'No Rewarded Host or Rewarder has signed up for this event yet.',
  };
}

// ----------------------------------------------------------------------------
//  Reaction add -> claim a role slot, or strip anything not in the five
// ----------------------------------------------------------------------------
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (err) {
    console.error('Could not fetch partial reaction/message:', err);
    return;
  }

  const record = getEvent(reaction.message.id);
  if (!record) return; // not a Leon event card, ignore entirely

  const role = EMOJI_TO_ROLE[reaction.emoji.name];

  // Only the five assigned emoji are allowed on an event card — strip anything else.
  if (!role) {
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }

  if (role === 'rewardedHost') {
    const guild = await client.guilds.fetch(CONFIG.guildId);
    const member = await guild.members.fetch(user.id).catch(() => null);
    const isAmbassador = member?.roles.cache.has(CONFIG.ambassadorRoleId);

    if (!isAmbassador) {
      await reaction.users.remove(user.id).catch(() => {});
      user
        .send(`Your reaction on **${record.title}** was removed: only Ambassadors can sign up as Rewarded Host.`)
        .catch(() => {});
      return;
    }
  }

  if (!record.roles[role].includes(user.id)) {
    record.roles[role].push(user.id);
    saveEvent(reaction.message.id, record);
    await reaction.message.edit({ embeds: [renderEmbed(record)] }).catch(() => {});
  }
});

// ----------------------------------------------------------------------------
//  Reaction remove -> release a role slot
// ----------------------------------------------------------------------------
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (err) {
    console.error('Could not fetch partial reaction/message:', err);
    return;
  }

  const record = getEvent(reaction.message.id);
  if (!record) return;

  const role = EMOJI_TO_ROLE[reaction.emoji.name];
  if (!role) return;

  const idx = record.roles[role].indexOf(user.id);
  if (idx !== -1) {
    record.roles[role].splice(idx, 1);
    saveEvent(reaction.message.id, record);
    await reaction.message.edit({ embeds: [renderEmbed(record)] }).catch(() => {});
  }
});

// ----------------------------------------------------------------------------
client.login(CONFIG.token);
