# Code Review & JSDoc Analysis

Analyze the file following these criteria:

## 1. JSDoc
- Add concise JSDoc (1-2 lines) to all public classes, methods, and functions
- Include @param, @returns, @throws when relevant
- Mark private methods with @private
- For types/interfaces: use inline comments /** ... */ on properties

## 2. Code Review
Identify issues by priority:

### =4 Critical (fix now):
- Race conditions (e.g., existsSync vs async fs.access)
- Memory leaks or critical performance issues
- Type safety problems (e.g., Map<string, string> without proper typing)
- Logic bugs

### =á Important (fix soon):
- Magic numbers without constants
- Silent catch blocks without logging
- Methods that should be getters
- Confusing variable names

### =5 Nice to have:
- Refactorings for better readability
- Extract complex functions
- Non-critical optimizations

## 3. Naming
- Clear variable and function names
- Naming consistency
- Avoid obscure abbreviations

## 4. Method Order
Evaluate class structure:
- Properties (static constants ’ instance properties)
- Constructor
- Public methods (lifecycle ’ core operations ’ observability)
- Private methods (grouped by context/responsibility)

Suggest improvements if needed.

---

**Response format:**
- List issues by priority (=4=á=5)
- Show current code vs suggested code
- Explain the "why" behind each change
- Summarize critical issues count at the end
