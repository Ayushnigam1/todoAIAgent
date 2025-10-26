PostgreSQL Docker Setup

This setup allows you to quickly run a PostgreSQL 16 instance locally using Docker.
It mounts a volume for data persistence and exposes the database on port 5431 (to avoid conflicts with any local Postgres installation).

📦 Requirements

Docker
 installed and running

Docker Compose
 installed (usually bundled with Docker Desktop)

 cmd
Start the Database --
  docker-compose up -d 
Check Running Containers ---
  docker ps


--- running drizzle studio for visualization
npm run studio
https://local.drizzle.studio
---start the server
node index.js
