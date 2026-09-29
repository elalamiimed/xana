/**
 * Task adapter — Xana's own task list, optionally unified with Todoist.
 *
 * Local SQLite is always the primary store: it is where Xana writes back, and
 * it works offline. When `XANA_TODOIST_TOKEN` is present, Todoist tasks are
 * merged in and de-duplicated against local ones by title.
 */

import type { AdapterStatus, Task } from "../core/types";
import { getStore } from "../core/store";
import { cred, defineAdapter, errorMessage, httpJson, status, type LifeAdapter } from "./types";

interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  priority?: number;
  due?: { date?: string; datetime?: string; string?: string } | null;
  labels?: string[];
  project_id?: string;
  checked?: boolean;
}

interface TodoistProject { id: string; name: string }

/** Todoist priority 4 is "urgent"; Xana's scale is 1 = highest. */
function toXanaPriority(p: number | undefined): Task["priority"] {
  switch (p) {
    case 4: return 1;
    case 3: return 2;
    case 2: return 3;
    default: return 4;
  }
}

export function tasksAdapter(): LifeAdapter {
  const token = cred("XANA_TODOIST_TOKEN");
  const id = "tasks";
  const label = token.present ? "Tasks (Todoist)" : "Tasks";

  const read = async (): Promise<{ data: { tasks: Task[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    const store = getStore();
    const local = store.listTasks({ status: ["open", "doing"], limit: 300 });
    const tasks: Task[] = [...local];

    if (!token.present) {
      return {
        data: { tasks },
        status: status(
          id, label, "local", "local",
          `${local.length} open · add XANA_TODOIST_TOKEN to sync Todoist`,
          Date.now() - t0,
        ),
      };
    }

    try {
      const headers = { Authorization: `Bearer ${token.value}` };
      const [remote, projects] = await Promise.all([
        httpJson<TodoistTask[]>("https://api.todoist.com/rest/v2/tasks", { headers, timeoutMs: 6000 }),
        httpJson<TodoistProject[]>("https://api.todoist.com/rest/v2/projects", { headers, timeoutMs: 6000 }).catch(
          () => [] as TodoistProject[],
        ),
      ]);
      const projectName = new Map(projects.map((p) => [p.id, p.name]));

      const localTitles = new Set(local.map((t) => t.title.trim().toLowerCase()));
      let merged = 0;
      for (const rt of remote) {
        if (rt.checked) continue;
        if (localTitles.has(rt.content.trim().toLowerCase())) continue; // local wins
        tasks.push({
          id: `todoist_${rt.id}`,
          title: rt.content,
          status: "open",
          due: rt.due?.datetime ?? rt.due?.date,
          project: rt.project_id ? projectName.get(rt.project_id) : undefined,
          people: [],
          priority: toXanaPriority(rt.priority),
          tags: rt.labels ?? [],
          source: "todoist",
          createdAt: new Date().toISOString(),
        });
        merged++;
      }
      return {
        data: { tasks },
        status: status(id, label, "connected", "live", `${merged} from Todoist · ${local.length} local`, Date.now() - t0),
      };
    } catch (err) {
      return {
        data: { tasks },
        status: status(
          id, label, "error", "local",
          `Todoist failed (${errorMessage(err)}) — using local list`,
          Date.now() - t0,
        ),
      };
    }
  };

  return defineAdapter<{ tasks: Task[] }>({
    id,
    label,
    ttlMs: 45_000,
    empty: { tasks: [] },
    produce: read,
  });
}
