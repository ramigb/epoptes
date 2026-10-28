<!-- template: The board's seed. Epoptes imports this file onto the board (the current job's epic) the first time it reads the goal, then renames it to backlog.md.imported; after that, cards live only on the board. Seed the milestones and tasks from the design. Milestone headings must keep the shape `## M<n> · <title> (target h:mm)`: the target is the active time by which it should be done, counted from the start of the run (the dashboard draws it on the clock bar). Each `- [ ]` line becomes a TODO card in that milestone; `[~]`, `[x]`, `[blocked: why]` and `[cut]` work too. -->
# Backlog seed

## M1 · {{first milestone: what is checkable at the end}} (target {{h:mm}})
- [ ] M1-1 {{task}}
- [ ] M1-2 {{task}}

## M2 · {{second milestone}} (target {{h:mm}})
- [ ] M2-1 {{task}}
