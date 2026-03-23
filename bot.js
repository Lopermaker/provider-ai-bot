require("dotenv").config()
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js")

const token = process.env.DISCORD_TOKEN
const apikey = process.env.CEREBRAS_API_KEY
const clientid = Buffer.from(token.split(".")[0], "base64").toString()

const memory = new Map()
const daily_limit = 1000000
let used_tokens = 0
let last_reset = new Date().getUTCDate()

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
})

const commands = [
    new SlashCommandBuilder()
        .setName("ask")
        .setDescription("ask the ai a question (high-speed)")
        .addStringOption(option => 
            option.setName("question")
                .setDescription("the question to ask")
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName("summarize")
        .setDescription("summarize recent channel messages")
        .addIntegerOption(option =>
            option.setName("limit")
                .setDescription("number of messages to summarize (default 50, max 100)")
                .setMinValue(1)
                .setMaxValue(100)),
    new SlashCommandBuilder()
        .setName("usage")
        .setDescription("check the bot's daily token usage"),
    new SlashCommandBuilder()
        .setName("clear")
        .setDescription("clear your conversation history with the ai")
].map(command => command.toJSON())

const rest = new REST({ version: "10" }).setToken(token)

async function register() {
    try {
        await rest.put(Routes.applicationCommands(clientid), { body: commands })
        console.log("slash commands registered.")
    } catch (error) {
        console.error("registration error:", error)
    }
}

function checkreset() {
    const now = new Date().getUTCDate()
    if (now !== last_reset) {
        used_tokens = 0
        last_reset = now
    }
}

async function getairesponse(userid, prompt) {
    if (!apikey) return "api key missing. set CEREBRAS_API_KEY in railway."
    checkreset()

    let history = memory.get(userid) || []
    history.push({ role: "user", content: prompt })

    try {
        const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apikey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "llama3.1-8b",
                messages: [
                    { role: "system", content: "your name is PROVIDER. you are a helpful ai assistant created by Xiaon32. use discord markdown." },
                    ...history
                ]
            })
        })

        const data = await response.json()
        
        if (!response.ok) {
            console.error("Cerebras API Error:", data)
            return `ai error: ${data.error?.message || JSON.stringify(data)}`
        }

        const result = data.choices[0].message.content
        const tokens = data.usage?.total_tokens || 0
        used_tokens += tokens

        history.push({ role: "assistant", content: result })
        if (history.length > 10) history.shift()
        memory.set(userid, history)

        return result
    } catch (error) {
        console.error("Fetch Error:", error)
        return `connection error: ${error.message}`
    }
}

function create_progress_bar(used, total) {
    const size = 15
    const percentage = Math.min(used / total, 1)
    const progress = Math.round(size * percentage)
    const empty = size - progress
    
    const progress_text = "🟩".repeat(progress)
    const empty_text = "⬛".repeat(empty)
    const percentage_text = Math.round(percentage * 100) + "%"
    
    return `${progress_text}${empty_text} **${percentage_text}**`
}

function chunk(str, size) {
    const chunks = []
    for (let i = 0; i < str.length; i += size) {
        chunks.push(str.slice(i, i + size))
    }
    return chunks
}

async function sendchunks(interaction, text) {
    const chunks = chunk(text, 2000)
    for (let index = 0; index < chunks.length; index++) {
        if (index === 0) {
            await interaction.editReply(chunks[index])
        } else {
            await interaction.followUp(chunks[index])
        }
    }
}

client.on("ready", async () => {
    console.log(`${client.user.tag} - PROVIDER ONLINE (Cerebras 8B)`)
    await register()
})

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === "ask") {
        await interaction.deferReply()
        const response = await getairesponse(interaction.user.id, interaction.options.getString("question"))
        await sendchunks(interaction, response)
    } else if (interaction.commandName === "summarize") {
        await interaction.deferReply()
        const limit = interaction.options.getInteger("limit") || 50
        const messages = await interaction.channel.messages.fetch({ limit })
        const context = messages.reverse().filter(m => !m.author.bot && m.content).map(m => `${m.author.username}: ${m.content}`).join("\n")

        if (!context) return interaction.editReply("no messages found.")

        const result = await getairesponse(interaction.user.id, `summarize this chat history concisely:\n\n${context}`)
        await sendchunks(interaction, result)
    } else if (interaction.commandName === "usage") {
        checkreset()
        const bar = create_progress_bar(used_tokens, daily_limit)
        const remaining = (daily_limit - used_tokens).toLocaleString()
        
        const embed = new EmbedBuilder()
            .setTitle("📊 System Usage")
            .setColor(0x2b2d31)
            .setDescription(`**Daily Token Limit:**\n${bar}\n\n**Used:** ${used_tokens.toLocaleString()}\n**Remaining:** ${remaining}\n\n*Limit resets daily.*`)
            .setFooter({ text: "PROVIDER Engine" })

        await interaction.reply({ embeds: [embed] })
    } else if (interaction.commandName === "clear") {
        memory.delete(interaction.user.id)
        await interaction.reply({ content: "memory cleared.", ephemeral: true })
    }
})

client.on("messageCreate", async (message) => {
    if (message.author.bot) return
    const isReplyToBot = message.reference && (await message.channel.messages.fetch(message.reference.messageId)).author.id === client.user.id
    if (isReplyToBot) {
        await message.channel.sendTyping()
        const response = await getairesponse(message.author.id, message.content)
        const chunks = chunk(response, 2000)
        for (const msg of chunks) await message.reply(msg)
    }
})

client.login(token)
