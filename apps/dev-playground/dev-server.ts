// import { DBX, server } from "../../dist/@databricks/apps"; 
import { DBX } from "@databricks-apps/core";
import { server } from "@databricks-apps/server";

DBX.init({
  plugins: [
    // analytics(),
    // genie(),
    server({
      autoStart: false,
      staticPath: './',
    }),
  ]
}).then((dbx) => {
  dbx.server.extend(app => {
    app.get("/ping", async (req, res) => {
      res.send("pong");
    });
  }).start();
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