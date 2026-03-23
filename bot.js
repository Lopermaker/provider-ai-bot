require("dotenv").config()
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js")

const token = process.env.DISCORD_TOKEN
const clientid = Buffer.from(token.split(".")[0], "base64").toString()

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
        .setDescription("ask the ai a question (unlimited)")
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

// DuckDuckGo AI Unlimited Bridge
async function getairesponse(userid, prompt) {
    let history = memory.get(userid) || []
    history.push({ role: "user", content: prompt })

    try {
        // Step 1: Get the required VQD token from DDG
        const statusresp = await fetch("https://duckduckgo.com/duckchat/v1/status", {
            headers: { "x-vqd-accept": "1" }
        })
        const vqd = statusresp.headers.get("x-vqd-4")

        // Step 2: Send the chat request
        const response = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-vqd-4": vqd,
                "Accept": "text/event-stream"
            },
            body: JSON.stringify({
                model: "gpt-4o-mini", // High quality, zero limit model
                messages: [
                    { role: "system", content: "your name is PROVIDER. helpful assistant created by Xiaon32. use discord markdown." },
                    ...history
                ]
            })
        })

        if (!response.ok) return "provider error. please retry."

        // Step 3: Parse the stream response
        const text = await response.text()
        const lines = text.split("\n")
        let result = ""
        
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const data = line.slice(6)
                if (data === "[DONE]") break
                try {
                    const parsed = JSON.parse(data)
                    if (parsed.message) result += parsed.message
                } catch (e) {}
            }
        }

        history.push({ role: "assistant", content: result })
        if (history.length > 10) history.shift()
        memory.set(userid, history)

        return result || "no response received."
    } catch (error) {
        console.error(error)
        return "connection error. trying again might help."
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
    console.log(`${client.user.tag} - UNLIMITED MODE ACTIVE`)
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

        const result = await getairesponse(interaction.user.id, `summarize this chat history concisely:\n\n${context}`)
        await sendchunks(interaction, result)
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
