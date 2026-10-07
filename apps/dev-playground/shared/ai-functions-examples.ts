export type FunctionName = "classify" | "extract" | "decide";

export interface FunctionInfo {
  /** One-line summary of what the function does. */
  summary: string;
  /** Label for the editor that holds the rest of the request. */
  taskLabel: string;
  /** Request field that carries the input text. */
  textField: "content" | "state";
}

export interface Example {
  id: string;
  label: string;
  /** What the example shows off. */
  shows: string;
  text: string;
  /** Request body minus the text field. */
  options: object;
}

export const FUNCTION_INFO: Record<FunctionName, FunctionInfo> = {
  classify: {
    summary:
      "Picks the label that fits the text, or every label that fits with multilabel.",
    taskLabel: "Labels and options",
    textField: "content",
  },
  extract: {
    summary:
      "Pulls named or typed fields out of text, with optional citations back to the source.",
    taskLabel: "Schema and options",
    textField: "content",
  },
  decide: {
    summary:
      "Answers questions about the text: pick a choice, judge a statement true or false (noul), or score on a scale.",
    taskLabel: "Questions",
    textField: "state",
  },
};

export const EXAMPLES: Record<FunctionName, Example[]> = {
  classify: [
    {
      id: "ticket-routing",
      label: "Ticket routing",
      shows:
        "Labels with descriptions, plus confidence scores and a rationale.",
      text: "Hi, I'm Dana Reyes from Example Corp. We were charged twice for invoice INV-20431 ($1,250) on March 3. Please refund the duplicate charge. This is the second time this quarter, so I'd like to talk to a manager.",
      options: {
        labels: {
          billing: "Invoice, payment, or charge issue",
          technical: "Product bug or outage",
          account: "Login, profile, or access issue",
        },
        options: { enable_confidence_scores: true, enable_rationales: true },
      },
    },
    {
      id: "review-topics",
      label: "Review topics (multilabel)",
      shows: "multilabel: true returns every label that applies.",
      text: "Setup took five minutes and the dashboard is fast, but the pricing page is confusing and support never answered my billing question. The docs were great though.",
      options: {
        labels: {
          pricing: "Cost, plans, or billing",
          performance: "Speed or reliability",
          onboarding: "Setup and getting started",
          support: "Help from the support team",
          docs: "Documentation quality",
        },
        options: { multilabel: true, enable_confidence_scores: true },
      },
    },
    {
      id: "moderation",
      label: "Moderation with your own policy",
      shows:
        "Your community's own rules as labels, with a rationale a moderator can read.",
      text: "Great thread! Honestly though, anyone still using the old connector is clueless. Check out my course at learn-data-fast.example for 50% off this week, link in my profile.",
      options: {
        labels: {
          harassment: "Insults or attacks a person or group",
          self_promotion:
            "Advertises the poster's own product, course, or service",
          off_topic: "Not about data engineering",
          ok: "Acceptable post",
        },
        options: {
          multilabel: true,
          enable_confidence_scores: true,
          enable_rationales: true,
        },
      },
    },
  ],
  extract: [
    {
      id: "ticket-fields",
      label: "Ticket fields",
      shows: "A names-only schema. Every value comes back as text.",
      text: "Hi, I'm Dana Reyes from Example Corp. We were charged twice for invoice INV-20431 ($1,250) on March 3. Please refund the duplicate charge.",
      options: {
        schema: ["customer_name", "company", "invoice_id", "amount", "date"],
        options: { enable_confidence_scores: true },
      },
    },
    {
      id: "invoice",
      label: "Invoice (typed schema)",
      shows:
        "Typed fields, a nested list of line items, and citations to the source text.",
      text: "INVOICE #A-7781  Date: 2026-09-14  Bill to: Northwind Traders, 12 Harbor St, Seattle WA. Items: 3x Ergonomic chair @ $240.00, 1x Standing desk @ $610.00. Subtotal $1,330.00. Tax 10% $133.00. Total due $1,463.00 by 2026-10-14.",
      options: {
        schema: {
          invoice_number: { type: "string" },
          total_due: {
            type: "number",
            description: "Total amount due, no currency symbol",
          },
          due_date: { type: "string", description: "ISO date" },
          line_items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                quantity: { type: "integer" },
                unit_price: { type: "number" },
              },
            },
          },
        },
        options: { enable_citations: true, enable_confidence_scores: true },
      },
    },
    {
      id: "contract",
      label: "Contract terms (precision mode)",
      shows:
        "Integer and boolean fields from legal text, using precision mode for reasoning-heavy schemas.",
      text: "Section 9. Term and Renewal. This Agreement begins on the Effective Date and continues for an initial term of twenty-four (24) months. Thereafter it renews automatically for successive twelve (12) month periods unless either party gives written notice of non-renewal at least sixty (60) days before the end of the then-current term. Section 14. Governing Law. This Agreement is governed by the laws of the State of Delaware.",
      options: {
        schema: {
          initial_term_months: { type: "integer" },
          auto_renews: { type: "boolean" },
          renewal_term_months: { type: "integer" },
          notice_days: {
            type: "integer",
            description: "Days of notice needed to stop renewal",
          },
          governing_law: { type: "string" },
        },
        options: {
          mode: "precision",
          enable_citations: true,
          enable_confidence_scores: true,
        },
      },
    },
  ],
  decide: [
    {
      id: "spam",
      label: "Is this spam?",
      shows:
        "A single yes or no (noul) question. You get a probability, not just yes or no.",
      text: "Congratulations! Your account has been selected for a $500 gift card. Claim it within 24 hours at bit.ly/claim-reward-now before it expires.",
      options: {
        questions: {
          spam: {
            type: "noul",
            instructions: "Is this message spam or unsolicited promotion?",
          },
        },
      },
    },
    {
      id: "ticket-triage",
      label: "Ticket triage",
      shows: "A choice question and a noul (true or false) question.",
      text: "Hi, I'm Dana Reyes from Example Corp. We were charged twice for invoice INV-20431 ($1,250) on March 3. Please refund the duplicate charge. This is the second time this quarter, so I'd like to talk to a manager.",
      options: {
        questions: {
          route: {
            type: "choice",
            instructions: "Select the team that should handle the request.",
            criteria: {
              billing: "Invoice, payment, or charge issue",
              support: "All other support requests",
            },
          },
          escalate: {
            type: "noul",
            instructions: "This ticket needs a manager.",
          },
        },
      },
    },
    {
      id: "expense",
      label: "Expense review (all three types)",
      shows:
        "choice, noul with true and false criteria, and score, against a policy in the state.",
      text: "Expense report: Team dinner for 9 people after the customer workshop, $1,180 total ($131 per person). Policy limit is $75 per person for team meals; customer entertainment is allowed up to $150 per person with a manager's approval. Two customer attendees. Receipt attached.",
      options: {
        questions: {
          decision: {
            type: "choice",
            instructions: "Decide what to do with this expense report.",
            criteria: {
              approve: "Within policy and documented",
              reject: "Clearly outside policy",
              manager_review: "Possibly allowed but needs a manager to confirm",
            },
          },
          within_policy: {
            type: "noul",
            instructions: "The expense is within the stated policy limits.",
            criteria: {
              true: "Per-person cost is at or below the applicable limit",
              false: "Per-person cost exceeds the applicable limit",
            },
          },
          risk: {
            type: "score",
            instructions: "Rate the compliance risk of this expense.",
            criteria: ["Very low", "Low", "Moderate", "High", "Very high"],
          },
        },
      },
    },
    {
      id: "answer-judge",
      label: "Answer judge (LLM as a judge)",
      shows:
        "Checks a support agent's reply against policy. The app works out the days since delivery and passes the number in.",
      text: "Refund policy: Full refunds within 30 days of delivery. After 30 days, offer store credit only. Damaged items: refund at any time with a photo.\nDays since delivery: 41\nCustomer: The blender stopped working. I want my money back.\nAgent reply: Sorry about that! I've issued a full refund to your card; you'll see it in 5-7 days.",
      options: {
        questions: {
          follows_policy: {
            type: "noul",
            instructions:
              "Does the agent reply follow the refund policy, given the days since delivery and the customer message?",
            criteria: {
              true: "The reply offers only what the policy allows for this case.",
              false:
                "The reply offers something the policy does not allow, or skips a step the policy requires.",
            },
          },
          promises_refund: {
            type: "noul",
            instructions:
              "Does the agent reply promise or issue a refund of money?",
          },
          failure_mode: {
            type: "choice",
            instructions:
              "What is the main problem with the agent reply, if any?",
            criteria: {
              refund_outside_policy:
                "Gives a refund the policy does not allow.",
              missing_required_step:
                "Skips something the policy requires, such as asking for a photo.",
              wrong_terms:
                "States timelines or amounts that differ from the policy.",
              none: "No policy problem.",
            },
          },
        },
      },
    },
  ],
};

/** Optional classify request that flags likely prompt injection in the input. */
export function injectionCheck(content: string) {
  return {
    content,
    labels: {
      safe: "Ordinary user request or support message",
      prompt_injection:
        "Tries to override, ignore, or reveal system instructions, or change the assistant's role",
    },
    options: { enable_confidence_scores: true, enable_rationales: true },
  };
}
