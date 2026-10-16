import {afterEach,it,expect} from 'vitest';
import {freshApp,setupAdmin,createUser,auth} from './test-helpers.js';
import type {FastifyInstance} from 'fastify';
const apps:FastifyInstance[]=[];
afterEach(async()=>{for(const app of apps.splice(0)){await app.close();if(app.db.open)app.db.close();}});
it('lets restaurant admins edit permission checkboxes and enforces them for staff',async()=>{
 const app=freshApp();apps.push(app);const admin=await setupAdmin(app);
 const staff=await createUser(app,admin.token,{name:'Cashier',pin:'2345',role:'cashier'});
 const saved=await app.inject({method:'PUT',url:`/api/users/${staff.id}/permissions`,headers:auth(admin.token),payload:{overrides:{'products.read':false}}});
 expect(saved.statusCode,saved.body).toBe(200);
 expect((await app.inject({url:'/api/products',headers:auth(staff.token)})).statusCode).toBe(403);
 expect((await app.inject({method:'PUT',url:`/api/users/${staff.id}/permissions`,headers:auth(staff.token),payload:{overrides:{'products.read':true}}})).statusCode).toBe(403);
 expect((await app.inject({method:'PUT',url:`/api/users/${admin.user.id}/permissions`,headers:auth(admin.token),payload:{overrides:{'users.read':false}}})).statusCode).toBe(409);
 const read=await app.inject({url:`/api/users/${staff.id}/permissions`,headers:auth(admin.token)});expect(read.json().permissions['products.read']).toBe(false);
});
