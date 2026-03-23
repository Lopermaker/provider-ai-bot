require("dotenv").config()
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js")
const fs = require("fs")
const path = require("path")

const token = process.env.DISCORD_TOKEN
const apikey = process.env.CEREBRAS_API_KEY
const clientid = Buffer.from(token.split(".")[0], "base64").toString()
const usage_path = path.join(__dirname, "usage.json")

const memory = new Map()
const daily_limit = 1000000
let used_tokens = 0
let last_reset = new Date().getUTCDate()

// Load saved usage
if (fs.existsSync(usage_path)) {
    try {
        const data = JSON.parse(fs.readFileSync(usage_path))
        used_tokens = data.used || 0
        last_reset = data.last_reset || new Date().getUTCDate()
    } catch (e) { console.error("usage load error") }
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
})

const commands = [
    new SlashCommandBuilder().setName("ask").setDescription("ask the ai (high-speed)").addStringOption(o => o.setName("question").setDescription("the question").setRequired(true)),
    new SlashCommandBuilder().setName("summarize").setDescription("summarize chat").addIntegerOption(o => o.setName("limit").setDescription("messages (max 100)")),
    new SlashCommandBuilder().setName("usage").setDescription("check daily usage")
        .addIntegerOption(o => o.setName("set").setDescription("Xiaon32 only: manually set usage amount")),
    new SlashCommandBuilder().setName("clear").setDescription("clear history")
].map(c => c.toJSON())

const rest = new REST({ version: "10" }).setToken(token)

async function register() {
    try { await rest.put(Routes.applicationCommands(clientid), { body: commands }) } catch (e) {}
}

function saveusage() {
    fs.writeFileSync(usage_path, JSON.stringify({ used: used_tokens, last_reset }))
}

function checkreset() {
    const now = new Date().getUTCDate()
    if (now !== last_reset) {
        used_tokens = 0
        last_reset = now
        saveusage()
    }
}

async function getairesponse(userid, prompt) {
    if (!apikey) return "api key missing."
    checkreset()

    let history = memory.get(userid) || []
    history.push({ role: "user", content: prompt })

    try {
        const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${apikey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama3.1-8b",
                messages: [{ role: "system", content: "your name is PROVIDER. created by Xiaon32. use markdown." }, ...history]
            })
        })

        const data = await response.json()
        if (!response.ok) return `ai error: ${data.error?.message || "error"}`

        used_tokens += (data.usage?.total_tokens || 0)
        saveusage()

        const result = data.choices[0].message.content
        history.push({ role: "assistant", content: result })
        if (history.length > 10) history.shift()
        memory.set(userid, history)
        return result
    } catch (e) { return "connection error." }
}

function create_progress_bar(used, total) {
    const size = 15
    const percentage = used / total
    const progress = used > 0 ? Math.max(1, Math.round(size * percentage)) : 0
    const empty = size - progress
    return `${"🟩".repeat(progress)}${"⬛".repeat(empty)} **${(percentage * 100).toFixed(2)}%**`
}

client.on("ready", async () => {
    console.log(`${client.user.tag} - PROVIDER ONLINE`)
    await register()
})

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === "usage") {
        const set_val = interaction.options.getInteger("set")
        if (set_val !== null && interaction.user.username === "Xiaon32") {
            used_tokens = set_val
            saveusage()
            return interaction.reply({ content: `usage manually set to ${set_val.toLocaleString()}.`, ephemeral: true })
        }

        checkreset()
        const bar = create_progress_bar(used_tokens, daily_limit)
        const embed = new EmbedBuilder()
            .setTitle("📊 System Usage")
            .setColor(0x2b2d31)
            .setDescription(`**Daily Token Limit:**\n${bar}\n\n**Used:** ${used_tokens.toLocaleString()}\n**Remaining:** ${(daily_limit - used_tokens).toLocaleString()}\n\n*Reset occurs daily.*`)
        await interaction.reply({ embeds: [embed] })
    } else if (interaction.commandName === "ask") {
        await interaction.deferReply()
        const response = await getairesponse(interaction.user.id, interaction.options.getString("question"))
        const chunks = response.match(/[\s\S]{1,2000}/g) || []
        for (let i = 0; i < chunks.length; i++) i === 0 ? await interaction.editReply(chunks[i]) : await interaction.followUp(chunks[i])
    } else if (interaction.commandName === "summarize") {
        await interaction.deferReply()
        const messages = await interaction.channel.messages.fetch({ limit: interaction.options.getInteger("limit") || 50 })
        const context = messages.reverse().filter(m => !m.author.bot && m.content).map(m => `${m.author.username}: ${m.content}`).join("\n")
        if (!context) return interaction.editReply("no messages.")
        const result = await getairesponse(interaction.user.id, `summarize this chat concisely:\n\n${context}`)
        const chunks = result.match(/[\s\S]{1,2000}/g) || []
        for (let i = 0; i < chunks.length; i++) i === 0 ? await interaction.editReply(chunks[i]) : await interaction.followUp(chunks[i])
    } else if (interaction.commandName === "clear") {
        memory.delete(interaction.user.id)
        await interaction.reply({ content: "cleared.", ephemeral: true })
    }
})

client.on("messageCreate", async (message) => {
    if (message.author.bot) return
    const isReply = message.reference && (await message.channel.messages.fetch(message.reference.messageId)).author.id === client.user.id
    if (isReply) {
        await message.channel.sendTyping()
        const response = await getairesponse(message.author.id, message.content)
        const chunks = response.match(/[\s\S]{1,2000}/g) || []
        for (const msg of chunks) await message.reply(msg)
    }
})

client.login(token)
