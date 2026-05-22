# CLAUDE.md

Development guardrails and behavioral guidelines optimized for the Smart Grid Simulator project workspace.

## 1. CORE BEHAVIORAL RULES
* **Ask, do not assume:** State assumptions explicitly before coding. If any instruction is ambiguous or uncertain, stop and ask.
* **Simplest solution first:** Choose the minimum required code that directly solves the problem. Eliminate speculative engineering.
* **Do not touch unrelated code:** Perform surgical changes. Do not modify, clean up, or refactor adjacent code, styling, or formatting unless explicitly requested.
* **Flag uncertainty explicitly:** Surface technical trade-offs, potential side effects, or structural confusion immediately before implementation.

## 2. TECH STACK & ARCHITECTURE
* **Language:** Python 3.10+
* **Backend Framework:** FastAPI (Asynchronous execution model)
* **Database:** MySQL (Configured via local XAMPP environment architecture)
* **Key Paradigms:** Reinforcement Learning (RL) environment logic, vector-based state transformations, and event-driven API routing structures.

## 3. CUSTOM STYLE PREFERENCES
* **Naming Conventions:** Mandate short, highly clean, and functional variable names (e.g., preference for compact identifiers over overly expressive syntax).
* **Logical Implementation:** Prioritize flat, clear, and direct control logic. Minimize deep nested loops, unnecessary abstractions, single-use classes, or excessive boilerplate configurations.

## 4. HARD STOPS & SAFETY
* **Human Confirmation Required:** Stop execution and await explicit verbal/written validation before performing:
    * Destructive operations (e.g., file deletions, table drops, or state resets).
    * Structural database schema mutations or alterations (e.g., modifying relational constraints, data types, or foreign keys).
    * Executing system-wide migrations.

## 5. SESSION END PROTOCOL
At the conclusion of every single development task or session, provide a structured summary covering:
1.  **Files Changed:** A concise checklist of files written or edited.
2.  **Modifications:** What exact logic or components were updated.
3.  **Intentionally Left Untouched:** A brief mention of adjacent or related blocks that were purposefully left alone to maintain code isolation.