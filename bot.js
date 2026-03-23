require("dotenv").config()
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js")

const token = process.env.DISCORD_TOKEN
const apikey = process.env.OPENROUTER_API_KEY
const clientid = Buffer.from(token.split(".")[0], "base64").toString()
const aitimeoutms = 45000

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
        console.log("registering commands...")
        await rest.put(
            Routes.applicationCommands(clientid),
            { body: commands }
        )
        console.log("commands registered globally.")
    } catch (error) {
        console.error("failed to register commands:", error)
    }
}

async function getairesponse(userid, prompt) {
    if (!apikey || apikey === "your_openrouter_key_here") {
        return "api key not configured. please set OPENROUTER_API_KEY in .env"
    }

    let history = memory.get(userid) || []
    history.push({ role: "user", content: prompt })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45000)

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apikey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/trae-ide",
                "X-Title": "Discord AI Bot"
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: "arcee-ai/trinity-large-preview:free",
                messages: [
                    { role: "system", content: "your name is PROVIDER. you are a helpful ai assistant created by Xiaon32, your sole owner and creator. use discord markdown for better readability: use # for headings, > for blockquotes, - for bullet points, and triple backticks for code blocks. if asked for your name, it is PROVIDER." },
                    ...history
                ]
            })
        })

        const data = await response.json()
        
        if (!response.ok) {
            console.error("api error:", data)
            return `api error: ${data.error?.message || "unknown error"}`
        }

        if (!data.choices || data.choices.length === 0) {
            console.error("no choices returned:", data)
            return "no response from ai."
        }

        const result = data.choices[0].message.content

        history.push({ role: "assistant", content: result })
        if (history.length > 10) history.shift()
        memory.set(userid, history)

        return result
    } catch (error) {
        console.error(error)
        if (error.name === "TimeoutError") {
            return "ai request timed out. please retry."
        }
        return "error communicating with ai service."
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
    console.log(`logged in as ${client.user.tag}`)
    await register()
})

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === "ask") {
        const question = interaction.options.getString("question")
        
        await interaction.deferReply()

        const response = await getairesponse(interaction.user.id, question)
        try {
            await sendchunks(interaction, response)
        } catch (error) {
            console.error("failed to send ask response:", error)
        }
    } else if (interaction.commandName === "summarize") {
        await interaction.deferReply()

        const limit = interaction.options.getInteger("limit") || 50
        const messages = await interaction.channel.messages.fetch({ limit })
        
        const context = messages
            .reverse()
            .filter(m => !m.author.bot && m.content)
            .map(m => `${m.author.username}: ${m.content}`)
            .join("\n")

        if (!context) {
            return interaction.editReply("no recent messages found to summarize.")
        }

        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apikey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "arcee-ai/trinity-large-preview:free",
                    messages: [
                        { role: "system", content: "summarize the provided discord conversation concisely. use discord markdown: use # for headings, > for blockquotes, and - for bullet points. you are an assistant created by Xiaon32." },
                        { role: "user", content: context }
                    ]
                })
            })

            const data = await response.json()
            if (!response.ok) {
                console.error("summarize api error:", data)
                return interaction.editReply("failed to summarize: api error.")
            }
            const result = data.choices[0].message.content
            await sendchunks(interaction, result)
        } catch (error) {
            console.error(error)
            await interaction.editReply("failed to summarize conversation.")
        }
    } else if (interaction.commandName === "clear") {
        memory.delete(interaction.user.id)
        await interaction.reply({
            content: "your conversation history has been cleared.",
            ephemeral: true
        })
    }
})

client.on("messageCreate", async (message) => {
    if (message.author.bot) return

    // Check if the message is a reply to our bot
    const isReplyToBot = message.reference && 
        (await message.channel.messages.fetch(message.reference.messageId)).author.id === client.user.id

    if (isReplyToBot) {
        await message.channel.sendTyping()
        
        const response = await getairesponse(message.author.id, message.content)
        const chunks = chunk(response, 2000)

        for (const msg of chunks) {
            await message.reply(msg)
        }
    }
})

client.on("error", (error) => {
    console.error("discord client error:", error)
})

process.on("unhandledRejection", (error) => {
    console.error("unhandled rejection:", error)
})

client.login(token)
