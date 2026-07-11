import http from "node:http";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Server is running on port 8766");
});

server.listen(8766, () => {
  console.log("Test server started on port 8766");
});
