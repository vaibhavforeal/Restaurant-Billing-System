import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import { loadCaptainHttps, startCaptainHttps } from "../../apps/server/src/captain-https.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(".e2e-scratch", { recursive: true });
const { app, fake } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({error:"not found"}));
app.get("/__qa/prints", async () => ({ prints: fake.sent.map(p => p.bytes.toString("utf8")) }));
const admin = await setupAdmin(app);
const waiter=await createUser(app,admin.token,{name:"Ravi",pin:"3456",role:"waiter"});
const cashier=await createUser(app,admin.token,{name:"Counter",pin:"2345",role:"cashier"});
const kitchen=await createUser(app,admin.token,{name:"Kitchen",pin:"4567",role:"kitchen"});
const post=async(url:string,payload:object)=>{const r=await app.inject({method:"POST",url,payload,headers:auth(admin.token)});if(r.statusCode>=400)throw Error(r.body);return r.json();};
const {printer}=await post("/api/printers",{name:"Kitchen printer",kind:"network",connection:"127.0.0.1:9999",paperWidth:80});
const {station}=await post("/api/kot-stations",{name:"Hot kitchen",printerId:printer.id});
const names=["Paneer tikka","Crispy corn","Veg kebab","Chilli potato","Dal tadka","Paneer butter masala","Vegetable biryani","Jeera rice","Butter naan","Garlic naan","Tandoori roti","Lachha paratha","Masala dosa","Idli sambar","Medu vada","Uttapam","Masala tea","Filter coffee","Sweet lassi","Fresh lime","Gulab jamun","Kulfi","Ice cream","Fruit salad"];
const products=[];const tables=[];
for(let c=0;c<6;c++){const {category}=await post("/api/categories",{name:["Starters","Mains","Breads","South Indian","Drinks","Desserts"][c],sortOrder:c});for(let j=0;j<4;j++){const {product}=await post("/api/products",{name:names[c*4+j],categoryId:category.id,pricePaise:[12000,9000,8500,6000][j],gstRate:c===4?18:5,isVeg:true,kotStationId:c<4?station.id:null,...(c===1&&j===2?{variants:[{name:"Regular",pricePaise:16000},{name:"Large",pricePaise:24000}]}:{})});products.push(product);}}
for(let n=1;n<=18;n++){const {table}=await post("/api/tables",{name:`T${String(n).padStart(2, "0")}d`.slice(0,-1),area:n<=12?"Dining":"Patio",sortOrder:n});tables.push(table);}
for(const table of tables.slice(6,9)){const {order}=await post("/api/orders",{clientRef:crypto.randomUUID(),type:"dine_in",tableId:table.id});await post(`/api/orders/${order.id}/items`,{items:[{clientRef:crypto.randomUUID(),productId:products[0].id,qty:2}]});}
mkdirSync("output/captain",{recursive:true});writeFileSync(".e2e-scratch/captain-fixture.json",JSON.stringify({admin,waiter,cashier,kitchen,products,tables}));
await app.listen({host:"127.0.0.1",port:4139});
const tls=loadCaptainHttps(resolve(".e2e-scratch/captain-tls-qa"));
const secure=tls?await startCaptainHttps(app,tls,"127.0.0.1"):null;
const close=async()=>{await secure?.close();await app.close();process.exit(0);};process.on("SIGINT",()=>void close());process.on("SIGTERM",()=>void close());
console.log("Captain fixture ready: http://127.0.0.1:4139/captain/" + (secure ? " and HTTPS on configured port" : " (HTTP loopback is sufficient for PWA browser tests)"));
