import { db } from "./db/index.js";
import { todosTable } from "./db/schema.js";
import { eq, ilike } from "drizzle-orm";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import readline from "readline";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ----------------------
// Database Functions
// ----------------------

async function getAllTodos() {
  const todos = await db.select().from(todosTable);
  return todos;
}

async function createTodo(todo) {
  const [newTodo] = await db.insert(todosTable).values({ todo }).returning({
    id: todosTable.id,
  });
  return newTodo.id;
}

async function deleteTodo(id) {
  await db.delete(todosTable).where(eq(todosTable.id, id));
  return { success: true };
}

async function searchTodo(search) {
  const todos = await db
    .select()
    .from(todosTable)
    .where(ilike(todosTable.todo, `%${search}%`));
  return todos;
}

// ----------------------
// ✅ Function Declarations (latest SDK format)
// ----------------------

const functionDeclarations = [
  {
    name: "getAllTodos",
    description: "Return all todos from the database",
    parametersJsonSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "createTodo",
    description: "Create a new todo, returns numeric id",
    parametersJsonSchema: {
      type: "object",
      properties: {
        todo: { type: "string", description: "Todo text" },
      },
      required: ["todo"],
    },
  },
  {
    name: "deleteTodo",
    description: "Delete a todo by id",
    parametersJsonSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Todo id" },
      },
      required: ["id"],
    },
  },
  {
    name: "searchTodo",
    description: "Search todos using pattern matching",
    parametersJsonSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search pattern string" },
      },
      required: ["search"],
    },
  },
];

// Group into tools (latest SDK shape)
const tools = [{ functionDeclarations }];

// Local tool mapping
const localTools = {
  getAllTodos,
  createTodo,
  deleteTodo,
  searchTodo,
};

// ----------------------
// Response JSON Schema
// ----------------------

const responseJsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["plan", "action", "observation", "output"] },
    plan: { type: "string" },
    action: {
      type: "object",
      properties: {
        function: {
          type: "string",
          enum: ["getAllTodos", "createTodo", "deleteTodo", "searchTodo"],
        },
        input: { type: ["object", "null"] },
      },
      required: ["function", "input"],
    },
    observation: {},
    output: { type: "string" },
  },
  required: ["type"],
};

// ----------------------
// SYSTEM PROMPT
// ----------------------

const SYSTEM_PROMPT = `
You are an AI TO-DO list Assistant with START, PLAN, ACTION, OBSERVATION AND OUTPUT states.
Wait for the user prompt and first PLAN using available tools.
After planning, take the ACTION with appropriate tools and wait for the Observation based on Action.
Once you get the Observations, return the AI response based on the start prompt and observations.

You can manage tasks by viewing, adding, updating, deleting them.
You must strictly follow the JSON output format.

TODO DB Schema:
- "id" integer PRIMARY KEY GENERATED ALWAYS
- "todo" text NOT NULL
- "created_at" timestamp DEFAULT now()
- "updated_at" timestamp

Available tools:
- getAllTodos(): Return all the todos from Database
- createTodo(todo:string): create a new todo in the Database and takes todo as string and return an id of created todo
- deleteTodo(id:integer): Delete that particular todo by id from Database and takes id as a integer
- searchTodo(search:string): Return all the Matching todos from Database using pattern matching

Always respond with valid JSON in one of these formats:
{"type": "plan", "plan": "your planning thoughts"}
{"type": "action", "action": {"function": "functionName", "input": {...}}}
{"type": "observation", "observation": "result from action"}
{"type": "output", "output": "your response to user"}
`;

// ----------------------
// TodoAgent Class
// ----------------------

class TodoAgent {
  constructor() {
    this.client = ai;
    this.modelName = "gemini-2.5-flash"; // ✅ stable model name
    this.tools = tools;
    this.responseJsonSchema = responseJsonSchema;
    this.conversationHistory = [];
  }

  async executeFunction(functionName, input) {
    try {
      console.log(`Executing ${functionName} with input:`, input);
      const fn = localTools[functionName];
      if (!fn) throw new Error(`Function ${functionName} not found`);
      const result = await fn(input ?? {});
      return result;
    } catch (error) {
      console.error(`Error executing ${functionName}:`, error);
      return { error: error.message };
    }
  }

  async processUserInput(userInput) {
    try {
      // start chat
       this.conversationHistory.push({
                role: "user",
                parts: [{ text: userInput }]
            });
      const chat = await this.client.chats.create({
        model: this.modelName,
        config: {
          tools: this.tools,
          systemInstruction: SYSTEM_PROMPT,
          responseJsonSchema: this.responseJsonSchema,
        },
        history: this.conversationHistory,
      });

    let currentState = "planning";
    let maxIterations = 10;
    let iterations = 0;

    // while (iterations < maxIterations) {
    //   iterations++;
      // send user message
      const initialResp = await chat.sendMessage({ message: userInput });
      console.log("AI raw response:", initialResp);

      // find function call
      const functionCall =
        initialResp.functionCalls?.[0] ||
        initialResp.candidates?.[0]?.content?.parts?.find(
          (p) => p.function_call
        )?.function_call ||
        null;

      if (functionCall) {
        const funcName = functionCall.name;
        let args = functionCall.args ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch (_) {}
        }

        // execute tool
        const toolResult = await this.executeFunction(funcName, args);

        // send observation back
        await chat.sendMessage({
          role: "tool",
          name: funcName,
          message: JSON.stringify(toolResult),
        });

        // ask for final response
        const finalResp = await chat.sendMessage({
          message: "Please continue and provide the final response.",
        });

        const output =
          finalResp.parsed ??
          finalResp.text ??
          finalResp.response?.text?.() ??
          JSON.stringify(finalResp);
          console.log("Final output after function call:", output);
        return { type: "output", output };
      } else {
        const parsed =
          initialResp.parsed ??
          initialResp.text ??
          initialResp.response?.text?.() ??
          JSON.stringify(initialResp);
        console.log("Parsed response without function call:", parsed);
        return { type: "output", output: parsed };
      }
    } catch (error) {
      console.error("Error in processUserInput:", error);
      return {
        type: "output",
        output: "I encountered an error processing your request.",
      };
    }
  }
}

// ----------------------
// CLI
// ----------------------

async function main() {
  const agent = new TodoAgent();

  if (process.argv.length > 2) {
    const userInput = process.argv.slice(2).join(" ");
    const res = await agent.processUserInput(userInput);
    console.log("\nAgent Response:", res.output);
    return;
  }

  console.log("Todo Agent started! Type 'exit' to quit.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => {
    rl.question("\nYou: ", async (input) => {
      if (input.toLowerCase() === "exit") {
        rl.close();
        return;
      }
      const r = await agent.processUserInput(input);
      console.log("value of r:", r);
      console.log("Agent:", r?.output);
      ask();
    });
  };
  ask();
}

export { TodoAgent, main };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
