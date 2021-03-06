const express = require("express");
const cors = require('cors');
const path = require("path");
const http = require("http");
const parseArgs = require("minimist");
const morgan = require("morgan");
const args = parseArgs(process.argv.slice(2));
const { name = "default", port = "3001" } = args;
const config = require("./config");
const app = express();
app.use(cors());
const request = require("request");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = require("socket.io")(server);
const redis = require("socket.io-redis");
const Precense = require("./config/presence");
io.adapter(redis({ host: config.redisHost, port: config.redisPort }));

const server_url = config.serverUrl;
const apiKey = config.apiKey;

var clusters = ["socket1-staging-tr.lembits.in"];

app.use(express.static(path.join(__dirname, "public")));
app.use(morgan("dev"));
app.get("/api/test", (req, res) => {
  res.json({
    headers: req.headers,
    address: req.connection.remoteAddress,
  });
});

app.get("/api/name", (req, res) => {
  res.json({ name });
});

app.get("/api/info", (req, res) => {
  fs.readFile(`${__dirname}/version.txt`, "utf8", (err, version) => {
    res.json({
      version: version || 0,
      dirname: __dirname,
      cwd: process.cwd(),
    });
  });
});

app.post("/debug", async function (req, res) {
  if (req.body.api_key !== undefined && req.body.api_key == apiKey) {
    try {
      const totalConnection = await Precense.activeUsers();
      const totalUsers = await Precense.getAllUsers();
      res.setHeader("Content-Type", "application/json");
      res.send(
        JSON.stringify({
          total_connections: totalConnection,
          total_users: totalConnection,
          users: totalUsers,
        })
      );
    } catch (error) {
      res.status(400).send(error.message);
    }
  }
});

app.post("/users", async function (req, res) {
  if (req.body.api_key !== undefined && req.body.api_key == apiKey) {
    try {
      const allUsers = await Precense.getAllUsers();
      res.status(200).json(allUsers);
    } catch (error) {
      console.log(error.message);
      res.status(400).send(error.message);
    }
  }
});

app.post("/send",  function (req, res) {
  var isValidKey = false;
  if (req.body.api_key !== undefined && req.body.api_key == apiKey) {
    try {
      if (req.body.user_ids !== undefined && req.body.user_ids.length) {
        req.body.user_ids.map(async(userId) => {
          const userlist = await Precense.getSocketIdsByUserId(userId);
          if (userlist.length) {
            userlist.map((socket_id) => {
              io.to(socket_id).emit(req.body.event, req.body.data);
            });
          }
        })
        
      } else {
        io.emit(req.body.event, req.body.data);
      }
    } catch (err) {}
    res.send("sent");
  } else {
    res.send("you are not authorized");
  }
});

function sendCluster(data) {
  clusters.forEach(function (cluster) {
    try {
      request.post(
        {
          url: cluster + "/send",
          json: {
            api_key: apiKey,
            event: "user_message",
            user_ids: [],
            data: JSON.stringify(data),
          },
        },
        function (error, response, body) {}
      );
    } catch (err) {
      console.log("send error");
      console.log(err);
    }
  });
}

io.on("connection", async function (socket) {
  var userId = socket.handshake.query.user_id;
  const isExists = await Precense.checkUser(userId);
  console.log("checking...",isExists);
  if (isExists) {
    await Precense.updateUserSocketId(userId, socket.id);
  } else {
    await Precense.setUser(userId, socket.id);
  }

  if (isExists == 1) {
    try {
      request(server_url + "/socket-login?type=1&id=" + userId);
      io.emit(
        "user_message",
        JSON.stringify({ type: "user_login", data: { user_id: userId } })
      );
    } catch (err) {
      console.log("login error : " + userId);
      console.log(err);
    }
  }

  socket.on("disconnect", async function (reason) {
    // redis store start
    var user_id = socket.handshake.query.user_id;
    await Precense.setInactiveUser(user_id);
    const inactive = await Precense.getInactiveUser();
    setTimeout(function () {
      if (inactive.length) {
        inactive.map((userId) => {
          try {
            request(server_url + "/socket-login?type=0&id=" + userId);
            io.emit(
              "user_message",
              JSON.stringify({ type: "user_logout", data: { user_id: userId } })
            );
          } catch (err) {
            console.log("logout error : " + userId);
            console.log(err);
          }
        });
      }
    }, 10000);
  });
  socket.on("heartbeat", (payload) => {
    payload.nodeName = name;
    socket.emit("heartbeat", payload);
  });
});

server.listen(+port, "0.0.0.0", (err) => {
  if (err) {
    console.log(err.stack);
    return;
  }

  console.log(`Node [${name}] listens on http://127.0.0.1:${port}.`);
});
