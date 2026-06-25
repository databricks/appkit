import {
  BarChart,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@databricks/appkit-ui/react";
import { AgentToolsProvider } from "@databricks/appkit-ui/react/beta";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { AgentChat } from "../components/agent-chat";

/**
 * "UI as a tool — out of the box" demo. This page registers NO tools of its
 * own (no `useAgentTool`). Every control below is plain appkit-ui, and the
 * agent can drive all of them because the components are agent-addressable out
 * of the box via the `useAgentElement` / `useAgentChart` hooks baked in.
 *
 * The tool catalog is flattened by verb — one `set_value` for every input, one
 * `select` for every tab/radio, one `choose` for every dropdown, one `toggle`,
 * one `open`/`close`, plus `read_chart` / `highlight_series` — each targeted by
 * an element `id`. The agent calls `ui_snapshot` to see what's on screen.
 *
 * Try: "fill the form for Ada Lovelace (ada@x.com), set role to Editor, pick
 * the Pro plan, enable notifications, accept terms, switch to the Activity tab,
 * then highlight the Profit series in the chart".
 */
export const Route = createFileRoute("/agent-native-ui")({
  component: AgentNativeUiRoute,
});

function AgentNativeUiRoute() {
  return (
    <AgentToolsProvider>
      <PageBody />
    </AgentToolsProvider>
  );
}

interface ProfileForm {
  name: string;
  email: string;
  bio: string;
  role: string;
  plan: string;
  notifications: boolean;
  terms: boolean;
}

const EMPTY_FORM: ProfileForm = {
  name: "",
  email: "",
  bio: "",
  role: "",
  plan: "",
  notifications: false,
  terms: false,
};

const REVENUE_DATA = [
  { month: "Jan", revenue: 120, profit: 40 },
  { month: "Feb", revenue: 150, profit: 55 },
  { month: "Mar", revenue: 170, profit: 60 },
  { month: "Apr", revenue: 140, profit: 35 },
  { month: "May", revenue: 200, profit: 90 },
  { month: "Jun", revenue: 230, profit: 110 },
];

function PageBody() {
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">
            Native components as tools
          </h1>
          <p className="text-base text-muted-foreground max-w-3xl">
            This page registers <strong>no tools of its own</strong>. Every
            control is plain appkit-ui — and the agent can drive all of them
            (type, choose, toggle, switch tabs, open dialogs, read & highlight
            the chart) because the components are agent-addressable out of the
            box. Try:{" "}
            <em>
              "fill the form for Ada Lovelace, set role to Editor, pick Pro,
              enable notifications, accept terms, open the Activity tab, then
              highlight the Profit series".
            </em>
          </p>
        </div>

        <div className="flex gap-6 mb-6">
          <ProfilePanel
            form={form}
            setForm={setForm}
            onReset={() => setForm(EMPTY_FORM)}
          />
          <AgentChat placeholder="Ask the agent to drive the UI…" />
        </div>

        <div className="flex gap-6">
          <ActivityPanel />
          <ChartPanel />
        </div>
      </div>
    </div>
  );
}

function ProfilePanel({
  form,
  setForm,
  onReset,
}: {
  form: ProfileForm;
  setForm: React.Dispatch<React.SetStateAction<ProfileForm>>;
  onReset: () => void;
}) {
  // DOM ids for label association only. The agent targets fields by the
  // independent, human-legible `agentId` below — not these.
  const uid = useId();
  const fid = (key: string) => `${uid}-${key}`;
  return (
    <div className="w-96 shrink-0 border rounded-lg bg-card p-6 flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Profile form
      </h2>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fid("name")}>Name</Label>
        <Input
          id={fid("name")}
          agentId="name"
          placeholder="Your name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fid("email")}>Email</Label>
        <Input
          id={fid("email")}
          agentId="email"
          type="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fid("bio")}>Bio</Label>
        <Textarea
          id={fid("bio")}
          agentId="bio"
          placeholder="A short bio"
          value={form.bio}
          onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Role</Label>
        <Select
          value={form.role || undefined}
          onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}
        >
          <SelectTrigger agentId="role" className="w-full">
            <SelectValue placeholder="Select a role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="editor">Editor</SelectItem>
            <SelectItem value="viewer">Viewer</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Plan</Label>
        <RadioGroup
          value={form.plan || undefined}
          onValueChange={(v) => setForm((f) => ({ ...f, plan: v }))}
        >
          {["free", "pro", "enterprise"].map((plan) => (
            <div key={plan} className="flex items-center gap-2">
              <RadioGroupItem value={plan} id={fid(plan)} />
              <Label htmlFor={fid(plan)} className="capitalize font-normal">
                {plan}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id={fid("notifications")}
          agentId="notifications"
          aria-label="notifications"
          checked={form.notifications}
          onCheckedChange={(v) =>
            setForm((f) => ({ ...f, notifications: v === true }))
          }
        />
        <Label htmlFor={fid("notifications")}>Email notifications</Label>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={fid("terms")}
          agentId="terms"
          aria-label="accept terms"
          checked={form.terms}
          onCheckedChange={(v) => setForm((f) => ({ ...f, terms: v === true }))}
        />
        <Label htmlFor={fid("terms")}>I accept the terms</Label>
      </div>

      <div className="flex gap-2 pt-2">
        <Dialog>
          <DialogTrigger asChild>
            <Button agentId="preview" disabled={!form.terms}>
              Preview
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Profile summary</DialogTitle>
              <DialogDescription>
                The current form state the agent has assembled.
              </DialogDescription>
            </DialogHeader>
            <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto">
              {JSON.stringify(form, null, 2)}
            </pre>
          </DialogContent>
        </Dialog>
        <Button agentId="reset" variant="outline" onClick={onReset}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function ActivityPanel() {
  return (
    <div className="w-96 shrink-0 border rounded-lg bg-card p-6">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
        Tabs (agent can switch)
      </h2>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger agentId="overview" value="overview">
            Overview
          </TabsTrigger>
          <TabsTrigger agentId="activity" value="activity">
            Activity
          </TabsTrigger>
          <TabsTrigger agentId="settings" value="settings">
            Settings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4 text-sm">
          Overview of the account. Ask the agent to switch tabs.
        </TabsContent>
        <TabsContent value="activity" className="pt-4 text-sm">
          Recent activity would appear here.
        </TabsContent>
        <TabsContent value="settings" className="pt-4 text-sm">
          Settings and preferences live here.
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChartPanel() {
  return (
    <div className="flex-1 border rounded-lg bg-card p-6 min-w-0">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
        Chart (agent can read &amp; highlight)
      </h2>
      <BarChart
        agentId="revenue"
        title="Monthly revenue"
        data={REVENUE_DATA}
        xKey="month"
        yKey={["revenue", "profit"]}
        height={260}
      />
      <p className="text-xs text-muted-foreground mt-2">
        Try: <em>"read the revenue chart"</em> or{" "}
        <em>"highlight the profit series"</em>.
      </p>
    </div>
  );
}
