FROM node:22-alpine
WORKDIR /app
COPY . .
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
