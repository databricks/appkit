import { DBX, server } from "@databricks/apps";
// import { DBX, server } from "../../../dist/@databricks/apps";
import path from "node:path";
// import { DBX } from "@databricks-apps/core";
// import { server } from "@databricks-apps/server";

const staticPath = path.resolve(process.cwd(), "client", "dist");

DBX.init({
  plugins: [
    // analytics(),
    // genie(),
    server({
      autoStart: false,
      watch: process.env.NODE_ENV === "development",
      staticPath,
    }),
  ],
}).then((dbx) => {
  dbx.server
    .extend(async (app) => {
      app.get("/api/ping", async (_req, res) => {
        res.send({ message: "pongggg" });
      });
    })
    .start();
  // dbx.server.start().then(app => {
  //   app.get("/ping", async (req, res) => {
  //     // res.send("pong");

  // dbx.genie.asUser('token').conversation.list();
  //     // dbx.genie.conversation.asUser('token').list();
  //     // dbx.genie.asUser('token');

  //     // dbx.genie.conversation.list;
  //     // dbx.genie.conversation.sendMessage;
  //     // dbx.genie.conversation.getMessages;
  //   });
  // });
});
