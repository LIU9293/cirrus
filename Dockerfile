# Single-service image: backend (tsx) serves the built SPA + /api, and builds
# miniapps at runtime via the miniapp-runtime vite project (so its deps stay).
FROM node:22-slim

WORKDIR /app

# Install deps for all three packages (full install — tsx + vite are needed at runtime).
COPY backend/package.json backend/package-lock.json* backend/
RUN npm --prefix backend install
COPY frontend/package.json frontend/package-lock.json* frontend/
RUN npm --prefix frontend install
COPY miniapp-runtime/package.json miniapp-runtime/package-lock.json* miniapp-runtime/
RUN npm --prefix miniapp-runtime install

# App source.
COPY . .

# Build the SPA (served statically by the backend).
RUN npm --prefix frontend run build

ENV NODE_ENV=production
# Railway injects PORT; the backend reads process.env.PORT.
CMD ["npm", "--prefix", "backend", "run", "start"]
