import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from both locations
dotenv.config();
try {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
} catch (e) {
  console.error("Error loading .env file:", e);
}

// JIRA configuration
const JIRA_HOST = process.env.JIRA_HOST || '';
const JIRA_BEARER_TOKEN = process.env.JIRA_BEARER_TOKEN || process.env.JIRA_API_TOKEN || '';

// Helper function to make JIRA API requests with Bearer token
async function jiraRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${JIRA_HOST}/rest/api/2${endpoint}`;
  
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${JIRA_BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`JIRA API error (${response.status}): ${errorText}`);
  }

  // Handle empty responses (like for transitions)
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// Type definitions
interface JiraTicket {
  summary: string;
  description: string;
  projectKey: string;
  issueType: string;
  parent?: string;
  customFields?: Record<string, any>;
}

interface JiraEpic {
  summary: string;
  description: string;
  projectKey: string;
  epicName: string;
  epicCategory?: string;
  productOwner?: string;
  uxOwner?: string;
}

interface JiraComment {
  body: string;
}

interface StatusUpdate {
  transitionId: string;
}

// Validation schemas
const TicketSchema = z.object({
  summary: z.string().describe("The ticket summary"),
  description: z.string().describe("The ticket description"),
  projectKey: z.string().describe("The project key (e.g., PROJECT)"),
  issueType: z.string().describe("The type of issue (e.g., Task, Bug, Epic)"),
  parent: z.string().optional().describe("The parent/epic key (for next-gen projects)"),
  customFields: z.record(z.any()).optional().describe("Custom fields as key-value pairs (e.g., {\"customfield_10620\": \"Epic Name\"})"),
});

const EpicSchema = z.object({
  summary: z.string().describe("The epic summary/title"),
  description: z.string().describe("The epic description"),
  projectKey: z.string().describe("The project key (e.g., LH)"),
  epicName: z.string().describe("The epic name (required for epics)"),
  epicCategory: z.string().optional().describe("The epic category"),
  productOwner: z.string().optional().describe("The product owner username"),
  uxOwner: z.string().optional().describe("The UX owner username"),
});

const CommentSchema = z.object({
  body: z.string().describe("The comment text"),
});

const StatusUpdateSchema = z.object({
  transitionId: z.string().describe("The ID of the transition to perform"),
});

// Helper function to validate Jira configuration
function validateJiraConfig(): string | null {
  if (!JIRA_HOST) return "JIRA_HOST environment variable is not set";
  if (!JIRA_BEARER_TOKEN) return "JIRA_BEARER_TOKEN or JIRA_API_TOKEN environment variable is not set";
  return null;
}

// Helper function to validate and format project keys
function validateAndFormatProjectKeys(projectKeys: string): string[] {
  return projectKeys
    .split(',')
    .map(key => key.trim().toUpperCase())
    .filter(key => key.length > 0);
}

// Helper function to escape special characters in JQL text search
function escapeJQLText(text: string): string {
  return text.replace(/[+\-&|!(){}[\]^~*?\\\/]/g, '\\$&');
}

// Create server instance
const server = new McpServer({
  name: "jira",
  version: "1.0.0"
});

// Register tools
server.tool(
  "list_tickets",
  "List Jira tickets assigned to you",
  {
    jql: z.string().optional().describe("Optional JQL query to filter tickets"),
  },
  async ({ jql }: { jql?: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const query = jql || 'assignee = currentUser() ORDER BY updated DESC';
      const data = await jiraRequest(`/search?jql=${encodeURIComponent(query)}&maxResults=50&fields=key,summary,status`);
      
      if (!data.issues || data.issues.length === 0) {
        return {
          content: [{ type: "text", text: "No tickets found" }],
        };
      }

      const formattedTickets = data.issues.map((issue: any) => {
        const summary = issue.fields?.summary || 'No summary';
        const status = issue.fields?.status?.name || 'Unknown status';
        return `${issue.key}: ${summary} (${status})`;
      }).join('\n');

      return {
        content: [{ type: "text", text: formattedTickets }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch tickets: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_ticket",
  "Get details of a specific Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PROJECT-123)"),
  },
  async ({ ticketId }: { ticketId: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const ticket = await jiraRequest(`/issue/${ticketId}?fields=key,summary,status,issuetype,description,parent,issuelinks`);

      const formattedTicket = [
        `Key: ${ticket.key}`,
        `Summary: ${ticket.fields?.summary || 'No summary'}`,
        `Status: ${ticket.fields?.status?.name || 'Unknown status'}`,
        `Type: ${ticket.fields?.issuetype?.name || 'Unknown type'}`,
        `Description:\n${ticket.fields?.description || 'No description'}`,
        `Parent: ${ticket.fields?.parent?.key || 'No parent'}`
      ];

      // Linked Issues Section
      const links = ticket.fields?.issuelinks || [];
      if (Array.isArray(links) && links.length > 0) {
        formattedTicket.push('\nLinked Issues:');
        for (const link of links) {
          if (link.outwardIssue) {
            const key = link.outwardIssue.key;
            const summary = link.outwardIssue.fields?.summary || 'No summary';
            const type = link.type?.outward || link.type?.name || 'Related';
            formattedTicket.push(`- [${type}] ${key}: ${summary}`);
          }
          if (link.inwardIssue) {
            const key = link.inwardIssue.key;
            const summary = link.inwardIssue.fields?.summary || 'No summary';
            const type = link.type?.inward || link.type?.name || 'Related';
            formattedTicket.push(`- [${type}] ${key}: ${summary}`);
          }
        }
      } else {
        formattedTicket.push('\nLinked Issues: None');
      }

      return {
        content: [{ type: "text", text: formattedTicket.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch ticket: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_comments",
  "Get comments for a specific Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PROJECT-123)"),
  },
  async ({ ticketId }: { ticketId: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const data = await jiraRequest(`/issue/${ticketId}/comment`);
      
      if (!data.comments || data.comments.length === 0) {
        return {
          content: [{ type: "text", text: "No comments found for this ticket." }],
        };
      }

      const formattedComments = data.comments.map((comment: any) => {
        const author = comment.author?.displayName || 'Unknown Author';
        const body = comment.body || 'No comment body';
        const createdDate = comment.created ? new Date(comment.created).toLocaleString() : 'Unknown date';
        return `[${createdDate}] ${author}:\n${body}\n---`;
      }).join('\n\n');

      return {
        content: [{ type: "text", text: formattedComments }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to fetch comments: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "create_ticket",
  "Create a new Jira ticket with optional custom fields",
  {
    ticket: TicketSchema,
  },
  async ({ ticket }: { ticket: JiraTicket }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const fields: any = {
        project: { key: ticket.projectKey },
        summary: ticket.summary,
        description: ticket.description,
        issuetype: { name: ticket.issueType },
      };

      if (ticket.parent) {
        fields.parent = { key: ticket.parent };
      }

      // Add custom fields if provided
      if (ticket.customFields) {
        Object.assign(fields, ticket.customFields);
      }

      const newTicket = await jiraRequest('/issue', {
        method: 'POST',
        body: JSON.stringify({ fields }),
      });

      return {
        content: [{ type: "text", text: `Created ticket: ${newTicket.key}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to create ticket: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "create_epic",
  "Create a new Jira Epic with required fields (Epic Name, Category, Owners)",
  {
    epic: EpicSchema,
  },
  async ({ epic }: { epic: JiraEpic }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      // Known custom field IDs for LH project epics
      // customfield_10620: Epic Name
      // customfield_14510: Epic Category
      // customfield_14511: Product Owner
      // customfield_14512: UX Owner
      const fields: any = {
        project: { key: epic.projectKey },
        summary: epic.summary,
        description: epic.description,
        issuetype: { name: 'Epic' },
        customfield_10620: epic.epicName,  // Epic Name (required)
      };

      // Add optional fields if provided
      if (epic.epicCategory) {
        fields.customfield_14510 = { value: epic.epicCategory };
      }
      if (epic.productOwner) {
        fields.customfield_14511 = { name: epic.productOwner };
      }
      if (epic.uxOwner) {
        fields.customfield_14512 = { name: epic.uxOwner };
      }

      const newEpic = await jiraRequest('/issue', {
        method: 'POST',
        body: JSON.stringify({ fields }),
      });

      return {
        content: [{ type: "text", text: `Created epic: ${newEpic.key}\nURL: ${JIRA_HOST}/browse/${newEpic.key}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to create epic: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "get_create_meta",
  "Get the required and available fields for creating issues in a project",
  {
    projectKey: z.string().describe("The project key (e.g., LH)"),
    issueType: z.string().optional().describe("Filter by issue type (e.g., Epic, Story, Bug)"),
  },
  async ({ projectKey, issueType }: { projectKey: string; issueType?: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      let url = `/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`;
      if (issueType) {
        url += `&issuetypeNames=${encodeURIComponent(issueType)}`;
      }
      
      const data = await jiraRequest(url);
      
      if (!data.projects || data.projects.length === 0) {
        return {
          content: [{ type: "text", text: `No project found with key: ${projectKey}` }],
        };
      }

      const project = data.projects[0];
      const result: string[] = [`Project: ${project.key} - ${project.name}\n`];

      for (const type of project.issuetypes || []) {
        result.push(`\n== Issue Type: ${type.name} ==`);
        const fields = type.fields || {};
        
        const requiredFields: string[] = [];
        const optionalFields: string[] = [];
        
        for (const [fieldId, fieldInfo] of Object.entries(fields) as [string, any][]) {
          const fieldStr = `  ${fieldId}: ${fieldInfo.name}${fieldInfo.required ? ' (REQUIRED)' : ''}`;
          if (fieldInfo.required) {
            requiredFields.push(fieldStr);
          } else if (fieldId.startsWith('customfield_')) {
            optionalFields.push(fieldStr);
          }
        }
        
        if (requiredFields.length > 0) {
          result.push('\nRequired Fields:');
          result.push(...requiredFields);
        }
        if (optionalFields.length > 0) {
          result.push('\nCustom Fields:');
          result.push(...optionalFields.slice(0, 20)); // Limit output
          if (optionalFields.length > 20) {
            result.push(`  ... and ${optionalFields.length - 20} more`);
          }
        }
      }

      return {
        content: [{ type: "text", text: result.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to get create meta: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "update_ticket",
  "Update a Jira ticket's fields (summary, description)",
  {
    ticketId: z.string().describe("The Jira ticket ID (e.g., PROJECT-123)"),
    summary: z.string().optional().describe("New summary/title for the ticket"),
    description: z.string().optional().describe("New description for the ticket"),
  },
  async ({ ticketId, summary, description }: { ticketId: string; summary?: string; description?: string }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    if (!summary && !description) {
      return {
        content: [{ type: "text", text: "No fields to update. Provide at least summary or description." }],
      };
    }

    try {
      const fields: any = {};
      if (summary) fields.summary = summary;
      if (description) fields.description = description;

      await jiraRequest(`/issue/${ticketId}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });

      return {
        content: [{ type: "text", text: `Updated ticket ${ticketId}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to update ticket: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "add_comment",
  "Add a comment to a Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID"),
    comment: CommentSchema,
  },
  async ({ ticketId, comment }: { ticketId: string; comment: JiraComment }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      await jiraRequest(`/issue/${ticketId}/comment`, {
        method: 'POST',
        body: JSON.stringify({ body: comment.body }),
      });

      return {
        content: [{ type: "text", text: `Added comment to ${ticketId}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to add comment: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "update_status",
  "Update the status of a Jira ticket",
  {
    ticketId: z.string().describe("The Jira ticket ID"),
    status: StatusUpdateSchema,
  },
  async ({ ticketId, status }: { ticketId: string; status: StatusUpdate }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      await jiraRequest(`/issue/${ticketId}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: status.transitionId } }),
      });

      return {
        content: [{ type: "text", text: `Updated status of ${ticketId}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to update status: ${(error as Error).message}` }],
      };
    }
  }
);

server.tool(
  "search_tickets",
  "Search for tickets in specific projects using text search",
  {
    searchText: z.string().describe("The text to search for in tickets"),
    projectKeys: z.string().describe("Comma-separated list of project keys"),
    maxResults: z.number().optional().describe("Maximum number of results to return"),
  },
  async ({ searchText, projectKeys, maxResults = 50 }: { searchText: string; projectKeys: string; maxResults?: number }) => {
    const configError = validateJiraConfig();
    if (configError) {
      return {
        content: [{ type: "text", text: `Configuration error: ${configError}` }],
      };
    }

    try {
      const projects = validateAndFormatProjectKeys(projectKeys);
      if (projects.length === 0) {
        return {
          content: [{ type: "text", text: "No valid project keys provided." }],
        };
      }

      const escapedText = escapeJQLText(searchText);
      const jql = `text ~ "${escapedText}" AND project IN (${projects.join(',')}) ORDER BY updated DESC`;

      const data = await jiraRequest(`/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=key,summary,status,updated,project,description`);

      if (!data.issues || data.issues.length === 0) {
        return {
          content: [{ type: "text", text: `No tickets found matching "${searchText}" in projects: ${projects.join(', ')}` }],
        };
      }

      const formattedResults = data.issues.map((issue: any) => {
        const summary = issue.fields?.summary || 'No summary';
        const status = issue.fields?.status?.name || 'Unknown status';
        const project = issue.fields?.project?.key || 'Unknown project';
        const updated = issue.fields?.updated ? 
          new Date(issue.fields.updated).toLocaleString() :
          'Unknown date';
        const description = issue.fields?.description || 'No description';
        
        return `[${project}] ${issue.key}: ${summary}
Status: ${status} (Updated: ${updated})
Description:
${typeof description === 'string' ? description.substring(0, 500) : 'No description'}
----------------------------------------\n`;
      }).join('\n');

      const totalResults = data.total || 0;
      const headerText = `Found ${totalResults} ticket${totalResults !== 1 ? 's' : ''} matching "${searchText}"\n\n`;

      return {
        content: [{ type: "text", text: headerText + formattedResults }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to search tickets: ${(error as Error).message}` }],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    const configError = validateJiraConfig();
    if (configError) {
      console.error(`Jira configuration error: ${configError}`);
      console.error("Please configure the required environment variables.");
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Jira MCP Server running on stdio (using Bearer token auth)");
  } catch (error) {
    console.error("Error starting Jira MCP server:", error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.error('Received SIGINT signal, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM signal, shutting down...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
