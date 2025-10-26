import { db } from "./db/index.js";
import { todosTable } from "./db/schema.js";
import { eq, ilike } from "drizzle-orm";
import "dotenv/config";
import { GoogleGenAI, types } from "@google/genai";
import readline from "readline"
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Database functions

async function getAllTodos() {
    const todos = await db.select().from(todosTable);
    return todos;
}

async function createTodo(todo) {
    const [newTodo] = await db.insert(todosTable).values({
        todo,
    }).returning({
        id: todosTable.id
    });
    return newTodo.id;
}

async function deleteTodo(id) {
    await db.delete(todosTable).where(eq(todosTable.id, id));
    return { success: true };
}

async function searchTodo(search) {
    const todos = await db.select().from(todosTable).where(ilike(todosTable.todo, `%${search}%`));
    return todos;
}

// Build FunctionDeclaration objects using the GenAI SDK types
const functionDeclarations = [
  types.FunctionDeclaration({
    name: "getAllTodos",
    description: "Return all todos from the database",
    // parameters: {} or explicit OBJECT schema — for getAllTodos no params
    parametersJsonSchema: {
      type: "object",
      properties: {}
    }
  }),
  types.FunctionDeclaration({
    name: "createTodo",
    description: "Create a new todo, returns numeric id",
    parametersJsonSchema: {
      type: "object",
      properties: {
        todo: { type: "string", description: "Todo text" }
      },
      required: ["todo"]
    }
  }),
  types.FunctionDeclaration({
    name: "deleteTodo",
    description: "Delete a todo by id",
    parametersJsonSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Todo id" }
      },
      required: ["id"]
    }
  }),
  types.FunctionDeclaration({
    name: "searchTodo",
    description: "Search todos using pattern matching",
    parametersJsonSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search pattern string" }
      },
      required: ["search"]
    }
  }),
 
];

// Group them into a Tool (each Tool can contain multiple functionDeclarations)
const toolsForModel = [ types.Tool({ functionDeclarations }) ];

// Tools mapping
const localTools = {
    getAllTodos: getAllTodos,
    createTodo: createTodo,
    deleteTodo: deleteTodo,
    searchTodo: searchTodo
};
// Response schema for structured output
const responseJsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["plan", "action", "observation", "output"] },
    plan: { type: "string" },
    action: {
      type: "object",
      properties: {
        function: { type: "string", enum: ["getAllTodos", "createTodo", "deleteTodo", "searchTodo"] },
        input: { type: ["object", "null"] }
      },
      required: ["function", "input"]
    },
    observation: {},
    output: { type: "string" }
  },
  required: ["type"]
};



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

Example:
START
{"type" : "user", "user": "Add a task for shopping groceries." }
{"type" : "plan" , "plan" : "I will try to get more context on what user need to shop."}
{"type" : "output" , "output" : "Can you tell me what all item you want to shop for?"}
{"type" : "user", "user": "I want to shop for milk, kurkure, lays and chocos" }
{"type" : "plan" , "plan" : "I will use createTodo to create a new Todo in DB."}
{"type" : "action" ,"function":"createTodo", "input" : "Shopping for milk, kurkure, lays and chocos"}
{"type" : "observation" , "observation" : 2}
{"type" : "output" , "output" : "your todo has been added successfully"}
`;

class TodoAgent {
    constructor() {
        this.client =ai;
        this.modelName = "gemini-2.5-flash";
        this.tools = tools;
        this.responseJsonSchema = responseJsonSchema;
        this.conversationHistory = [];
    }
    

    async executeFunction(functionName, input) {
        try {
            console.log(`Executing ${functionName} with input:`, input);
            const fn = localTools[functionName];
            if (!fn) {
                throw new Error(`Function ${functionName} not found`);
            }
            const result = await fn(input ?? {});

            return result;
        } catch (error) {
            console.error(`Error executing ${functionName}:`, error);
            return { error: error.message };
        }
    }

    async processUserInput(userInput) {
        try {
          // start a stateful chat
      const chat = await this.client.chats.create({
        model: this.modelName,
        config: {
          tools: this.tools,
          responseMimeType: "application/json",
          responseJsonSchema: this.responseJsonSchema,
          // functionCalling: { mode: "AUTO" } // optional
        }
      });
           // send the user message
      const initialResp = await chat.sendMessage({ content: userInput });
      // helper: find function_call in response (SDK shapes vary; check resp fields)
      const functionCall = initialResp.functionCalls?.[0]
                        || (initialResp.candidates?.[0]?.content?.parts?.find(p => p.function_call)?.function_call)
                        || null;
    
      if (functionCall) {
        // model asked to call a function
        const funcName = functionCall.name;
        // args may be a string or already parsed object depending on SDK; try parsing
        let args = functionCall.args ?? {};
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch (_) { /* keep string */ }
        }
         // execute tool
        const toolResult = await this.executeFunction(funcName, args);

         // send tool's observation back to the chat as a tool message
        await chat.sendMessage({
          role: "tool",
          name: funcName,
          content: JSON.stringify(toolResult)
        });
         // ask model to continue and finalize response
        const finalResp = await chat.sendMessage({ content: "Please continue and provide the final response." });

        // If SDK parsed according to responseJsonSchema, finalResp.parsed may exist
        const output = finalResp.parsed ?? (finalResp.text ?? finalResp.response?.text?.());
        return { type: "output", output };
    }
    else {
        // No function call — model returned direct JSON output or text
        const parsed = initialResp.parsed ?? initialResp.text ?? initialResp.response?.text?.();
        return { type: "output", output: parsed };
    }
            // let currentState = "planning";
            // let maxIterations = 10;
            // let iterations = 0;

            // while (iterations < maxIterations) {
            //     iterations++;
                
            //     const result = await chat.sendMessage(
            //         currentState === "planning" 
            //             ? `Plan how to respond to: "${userInput}"` 
            //             : "Continue with the next step"
            //     );

            //     const responseText = result.response.text();
            //     console.log("AI Response:", responseText);

            //     let aiResponse;
            //     try {
            //         aiResponse = JSON.parse(responseText);
            //     } catch (e) {
            //         console.error("Failed to parse AI response as JSON:", responseText);
            //         return { type: "output", output: "I apologize, but I encountered an error processing your request." };
            //     }

            //     // Handle different response types
            //     switch (aiResponse.type) {
            //         case "plan":
            //             console.log("Planning:", aiResponse.plan);
            //             currentState = "action";
            //             break;

            //         case "action":
            //             console.log("Taking action:", aiResponse.action);
            //             const observation = await this.executeFunction(
            //                 aiResponse.action.function, 
            //                 aiResponse.action.input
            //             );
                        
            //             // Send observation back to the model
            //             await chat.sendMessage(`Observation: ${JSON.stringify(observation)}`);
            //             currentState = "output";
            //             break;

            //         case "observation":
            //             console.log("Observation noted:", aiResponse.observation);
            //             currentState = "output";
            //             break;

            //         case "output":
            //             console.log("Final output:", aiResponse.output);
            //             // Add assistant response to conversation history
            //             this.conversationHistory.push({
            //                 role: "model",
            //                 parts: [{ text: aiResponse.output }]
            //             });
            //             return aiResponse;

            //         default:
            //             console.error("Unknown response type:", aiResponse.type);
            //             return { type: "output", output: "I encountered an unexpected error." };
            //     }
            // }

            // return { type: "output", output: "I couldn't complete the task within the allowed steps." };

        } catch (error) {
            console.error("Error in processUserInput:", error);
            return { type: "output", output: "I apologize, but I encountered an error processing your request." };
        }
    }
}

// Usage example and CLI interface
async function main() {
    const agent = new TodoAgent();
    
    console.log("Todo Agent started! Type 'exit' to quit.");
    
    // Simple CLI interface for testing
    if (process.argv.length > 2) {
        const userInput = process.argv.slice(2).join(' ');
        const response = await agent.processUserInput(userInput);
        console.log("\nAgent Response:", response.output);
        return;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const askQuestion = () => {
        rl.question('\nYou: ', async (input) => {
            if (input.toLowerCase() === 'exit') {
                console.log("Goodbye!");
                rl.close();
                return;
            }

            const response = await agent.processUserInput(input);
            console.log("Agent:", response.output);
            askQuestion();
        });
    };

    askQuestion();
}

// Export for use in other modules
export { TodoAgent, main };

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}