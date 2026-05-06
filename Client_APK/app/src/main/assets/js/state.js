/**
 * procMessenger Mobile - Global State
 *
 * All shared mutable state for the application.
 * Loaded first so every other module can reference these variables.
 */

// --- Connection ---
let wsManager = null;
let connectedClients = [];        // Array of client info from server
let clientNicknames = {};          // clientName -> nickname (persisted in localStorage)
let selectedTargets = new Set();   // Multi-select: which computers to send to

// --- Main Tab State ---
let activeMainTab = "client";     // "client" | "files" | "logs"
let logUnreadCount = 0;           // Unread log entries since last Logs tab visit

// --- Message / Log State ---
let messageTabs = {};              // clientName -> array of messages
let activeTab = null;              // Currently viewed log tab name

// --- LLM State ---
let llmProviders = [];             // Available LLM providers from llm_announce
let llmModes = [];                 // Available LLM modes from llm_announce
let llmSystemPrompts = [];         // Available system prompts from llm_announce
let llmActiveChatName = "";        // Currently active chat name
let llmChatHistory = [];           // Messages in the active LLM chat
let llmChatList = [];              // List of saved chat sessions
let llmModelsRequested = false;    // True after the first automatic model fetch this session
let llmResearchResults = [];       // Tavily search results (NOT part of chat history)
let llmResearchChatName = "";      // Which chat the current research results belong to

// --- Topic State ---
let serverTopics = [];             // List of topics from server
let selectedTopicIds = new Set();  // Set of IDs of selected topics

// --- branchShredder State ---
let bsRecentScenes = [];           // From system → recent_scenes response
let bsNodeIndex = [];              // From find_nodes response - lightweight node list

// --- branchShredder Viewport State ---
let bsViewportImage = null;        // Last received base64 PNG viewport image
let bsViewportLoading = false;     // True while awaiting a viewport response
let bsViewportState = null;        // Last known { x, y, zoom } from viewportState responses

// --- Blog Entry State ---
let blogEntryDraft = null;         // Current draft { name, keywords, date, body, eid }

// --- procIndex State ---
let piSearchResults = [];          // Last search results from procIndex
let piAnnounceInfo = null;         // Last announce payload (null = not yet seen)

// --- File Browser State ---
let fbFileList = [];               // Aggregated file list from server
// In-flight chunk assembly: fileId -> { record, chunks: {index -> base64}, totalChunks }
let fbInFlight = {};
let fbSelectedFileId = null;       // Currently selected file ID
let fbLastTap = { id: null, time: 0 }; // For double-tap detection
let fbEditingFileId = null;        // fileId of the file being edited (null for new files)
