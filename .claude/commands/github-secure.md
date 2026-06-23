---
description: Scan project for secrets, .gitignore gaps, and sensitive files before pushing to GitHub
---

# GitHub Security Pre-Push Scanner

Run a comprehensive security scan of the current project before pushing to GitHub.

## Steps

### 1. Run the scanner
Execute the PowerShell scanner:
```powershell
& "$env:USERPROFILE\.claude\scripts\github-secure.ps1" -ProjectRoot "$PWD" -Json
```

### 2. Analyze findings
From the JSON output, identify:
- **CRITICAL/HIGH secrets** - hardcoded API keys, tokens, passwords
- **Merge conflicts** - files with unresolved `<<<<<<<` / `>>>>>>>` markers
- **Cleanup targets** - log files, state files, temp files to delete
- **Gitignore gaps** - missing entries in .gitignore
- **Git history warnings** - secrets found in old commits

### 3. Fix secrets
For each hardcoded secret found:
- Replace with `process.env.VAR_NAME || ''` in JS/TS/Python
- Ask the user for the environment variable name
- Use the Edit tool to make the replacement

### 4. Update .gitignore
Append any missing entries to the project's `.gitignore` file.

### 5. Delete sensitive artifacts
Remove log files, state files, and temp files. If tracked by git, use `git rm --cached` first.

### 6. Report merge conflicts
Show file paths and line numbers. Do NOT auto-resolve.

### 7. Warn about git history
If old commits contain secrets, recommend credential rotation and git filter-branch.

### 8. Final verification
Re-run the scanner. Confirm `"Summary": "CLEAN - Safe to push"`.

### 9. Summary table
Present a final table with all findings and actions taken.
