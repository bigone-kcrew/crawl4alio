# ALIO 조항 검색 API — postgres와 같은 ai-internal 네트워크에서 실행
FROM node:24-bookworm

WORKDIR /app
RUN npm init -y >/dev/null && npm install pg@^8.22.0 --no-audit --no-fund

COPY search.js api_server.js ./

ENV PORT=8090 HOST=0.0.0.0
EXPOSE 8090

CMD ["node", "api_server.js"]
