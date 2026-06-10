@echo off
cd /d "E:\TARAK WEB APPS"
set PORTAL_API_TOKEN=B9jgrFE5Qx3o0f1MVeDvGPubT8nWNAcsXimy6SwR
set GMAIL_CREDENTIALS_FILE=E:\hcp_rd_agent\credentials.json
set GMAIL_TOKEN_FILE=E:\hcp_rd_agent\token.json
set GMAIL_SENDER=purchase@hcpwellness.in
set GOOGLE_SEARCH_API_KEY=AIzaSyAidO4w7lg8gtuy0HiDGxmDa5pcZTCIAMk
set GOOGLE_SEARCH_CX=30ca4c198d5b24fd8
set RD_AGENT_DB=E:\hcp_rd_agent\rd_agent_log.db
set RD_AGENT_CC=purchase2@hcpwellness.in,sonal@hcpwellness.in
python app.py