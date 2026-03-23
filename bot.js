require("dotenv").config()
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js")

const token = process.env.DISCORD_TOKEN
const clientid = Buffer.from(token.split(".")[0], "base64").toString()
const aitimeoutms = 60000

const memory = new Map()

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
        .setDescription("ask the ai a question")
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
        .setName("clear")
        .setDescription("clear your conversation history with the ai")
].map(command => command.toJSON())

const rest = new REST({ version: "10" }).setToken(token)

async function register() {
    try {
        await rest.put(Routes.applicationCommands(clientid), { body: commands })
    } catch (error) {
        console.error("registration error:", error)
    }
}

async function getairesponse(userid, prompt) {
    let history = memory.get(userid) || []
    history.push({ role: "user", content: prompt })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), aitimeoutms)

    try {
        // Updated to use the correct GET endpoint for simpler text generation
        // format: https://text.pollinations.ai/prompt?model=openai&system=...
        const systemprompt = "your name is PROVIDER. you are a helpful ai assistant created by Xiaon32. use discord markdown: # headings, > quotes, - bullets, and triple backticks for code."
        const encodedprompt = encodeURIComponent(prompt)
        const encodedsystem = encodeURIComponent(systemprompt)
        
        // We include a random seed to ensure unique responses
        const seed = Math.floor(Math.random() * 1000000)
        const url = `https://text.pollinations.ai/${encodedprompt}?model=openai&system=${encodedsystem}&seed=${seed}`

        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal
        })

        if (!response.ok) {
            console.error("pollinations error:", response.status)
            return "service busy. try again in a second."
        }
        
        const result = await response.text()
        
        history.push({ role: "assistant", content: result })
        if (history.length > 10) history.shift()
        memory.set(userid, history)

        return result
    } catch (error) {
        console.error("ai error:", error)
        return error.name === "AbortError" ? "provider took too long to think." : "connection error."
    } finally {
        clearTimeout(timeout)
    }
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
    console.log(`${client.user.tag} - infinite mode active`)
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

        if (!context) return interaction.editReply("no messages.")

        try {
            const system = "summarize this chat concisely using discord markdown. you were created by Xiaon32."
            const url = `https://text.pollinations.ai/${encodeURIComponent(context)}?system=${encodeURIComponent(system)}`
            
            const response = await fetch(url)
            const result = await response.text()
            await sendchunks(interaction, result)
        } catch (error) {
            await interaction.editReply("summary failed.")
        }
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
