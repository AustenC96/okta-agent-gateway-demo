#!/bin/sh
# Packages both MCP servers into infra/mcp.zip. The CRM Lambda uses handler crm.handler and the HR Lambda uses hr.handler.
set -e
cd "$(dirname "$0")/mcp"
rm -f ../mcp.zip
zip -q ../mcp.zip core.mjs crm.mjs hr.mjs
unzip -l ../mcp.zip | tail -n +4
