#!/bin/bash
# Post-tool hook to format files after Edit/Write operations.
# This mirrors "format on save" behavior in IDEs.
#
# NOT ENABLED BY DEFAULT. To enable, add to your .claude/settings.local.json:
#
#   {
#     "hooks": {
#       "PostToolUse": [
#         {
#           "matcher": "Edit|Write",
#           "hooks": [{ "type": "command", "command": ".claude/hooks/format-file.sh" }]
#         }
#       ]
#     }
#   }
#

FILE_PATH=$(jq -r '.tool_input.file_path')

# TypeScript/JavaScript - use prettier
if [[ "$FILE_PATH" =~ \.(ts|tsx|js|jsx|mjs|cjs)$ ]]; then
  pnpm prettier --write "$FILE_PATH" 2>/dev/null
fi

# Rust - use cargo fmt
if [[ "$FILE_PATH" =~ \.rs$ ]]; then
  cargo fmt -- "$FILE_PATH" 2>/dev/null
fi

exit 0
