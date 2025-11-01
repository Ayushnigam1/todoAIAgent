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
  const [newTodo] = await db.insert(todosTable).values({ todo }).returning();
  return newTodo;
}
async function deleteTodo({ id }) {
  await db.delete(todosTable).where(eq(todosTable.id, id));
  return { success: true, message: `Todo ${id} deleted successfully` };
}

async function searchTodo({search}) {
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
    description: "Create a new todo, returns itm with id",
    parametersJsonSchema: {
      type: "string",
      description: "Todo text",
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
    this.modelName = "gemini-2.5-flash";
    this.tools = [{ functionDeclarations }];
    this.conversationHistory = [];
  }

  async executeFunction(functionName, input) {
    try {
      console.log(`Executing ${functionName} with input:`, input);
      const fn = localTools[functionName];
      if (!fn) throw new Error(`Function ${functionName} not found`);
      return await fn(input ?? {});
    } catch (error) {
      console.error(`Error executing ${functionName}:`, error);
      return { error: error.message };
    }
  }

  async processUserInput(userInput) {
    try {
      // Add user message to history
      this.conversationHistory.push({
        role: "user",
        parts: [{ text: userInput }],
      });

      let currentState = "planning";
      let maxIterations = 10;
      let iterations = 0;
      let lastAIMessage = userInput;

      while (iterations < maxIterations) {
        iterations++;

        // 1️⃣ Generate AI content
        const response = await this.client.models.generateContent({
          model: this.modelName,
          contents: lastAIMessage,
          config: {
            tools: this.tools,
            systemInstruction: SYSTEM_PROMPT,
          },
          history: this.conversationHistory,
        });

        // 2️⃣ Parse AI response JSON
        const rawText = response.text ?? "";

        const jsonStrings = rawText
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const s of jsonStrings) {
          let aiResponse;
          try {
            aiResponse = JSON.parse(s);
          } catch {
            console.log("Failed to parse JSON, treating as output:");
            aiResponse = { type: "output", output: s };
          }

          // 3️⃣ Handle PLAN → ACTION → OBSERVATION → OUTPUT
          switch (aiResponse.type) {
            case "plan":
              console.log("PLAN:", aiResponse.plan);
              currentState = "action";
              lastAIMessage = "Proceed to next step";
              break;

            case "action":
              console.log("ACTION:", aiResponse.action);
              const observation = await this.executeFunction(
                aiResponse.action.function,
                aiResponse.action.input
              );
              console.log("OBSERVATION RESULT:", observation);
              // Feed observation back into AI
              this.conversationHistory.push({
                role: "tool",
                name: aiResponse.action.function,
                parts: [
                  {
                    functionResponse: {
                      name: aiResponse.action.function,
                      response: { result: observation },
                    },
                  },
                ],
              });

              currentState = "observation";
              lastAIMessage = `Here is the observation for ${
                aiResponse.action.function
              }: ${JSON.stringify(observation)}. Proceed to next step.`;
              break;

            case "observation":
              console.log("OBSERVATION:", aiResponse.observation);
              currentState = "output";
              lastAIMessage = "Prepare final response";
              break;

            case "output":
              // console.log("OUTPUT:", aiResponse.output);
              this.conversationHistory.push({
                role: "model",
                parts: [{ text: aiResponse.output }],
              });
              return aiResponse;

            default:
              console.error("Unknown response type:", aiResponse.type);
              return { type: "output", output: text };
          }
        }
      }

      // Fallback if max iterations reached
      return {
        type: "output",
        output: "Reached maximum iterations without producing output.",
      };
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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = () => {
    rl.question("\nYou: ", async (input) => {
      if (input.toLowerCase() === "exit") {
        rl.close();
        return;
      }
      const r = await agent.processUserInput(input);
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
