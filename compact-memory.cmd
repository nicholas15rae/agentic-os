@echo off
rem compact-memory: archive Tier-1 history, distill into Memory Scrolls, sync changed scrolls.
rem Usage: compact-memory --dry-run  /  compact-memory  /  compact-memory --json
python "%~dp0scripts\compact_memory.py" %*
