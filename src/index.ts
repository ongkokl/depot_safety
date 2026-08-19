interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: { send(message: any): Promise<any> };
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BOOTSTRAP_SUPER_ADMIN_EMAIL: string;
  EMAIL_FROM: string;
  ADMIN_NOTIFICATION_EMAIL: string;
  SESSION_SECRET: string;
}

const COOKIE = "sir_session";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS_PER_ITEM = 8;
const ALLOWED_TYPES = new Set(["image/jpeg","image/png","image/webp","image/heic","image/heif"]);
const FINDING_TYPES = new Set(["safe_good_practice","unsafe_act","unsafe_condition","improvement_opportunity"]);
const ACTION_STATUSES = new Set(["closed","open","in_progress","ready_for_closure","closure_requested","rejected"]);

function json(data: unknown, status=200, headers: Record<string,string>={}) {
  return new Response(JSON.stringify(data), {status, headers: {"content-type":"application/json; charset=utf-8", ...headers}});
}
function bad(message:string,status=400){return json({error:message},status);}
function esc(s:string){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));}
function randomString(n=32){const a=new Uint8Array(n);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/[+/=]/g,"").slice(0,n);}
function base64url(bytes:ArrayBuffer|Uint8Array){const a=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);let s="";for(const b of a)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function sha256(s:string){return crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));}
async function hmac(s:string,secret:string){return base64url(await crypto.subtle.sign("HMAC",await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]),new TextEncoder().encode(s)));}
async function signSession(payload:any,secret:string){const body=base64url(new TextEncoder().encode(JSON.stringify(payload)));return `${body}.${await hmac(body,secret)}`;}
async function readSession(request:Request,env:Env){
  const raw=request.headers.get("Cookie")?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]; if(!raw)return null;
  const [body,sig]=raw.split("."); if(!body||!sig)return null;
  if((await hmac(body,env.SESSION_SECRET))!==sig)return null;
  try{const p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0))));if(p.exp<Date.now())return null;return p;}catch{return null;}
}
function cookie(value:string,maxAge:number){return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
async function pkce(){
  const verifier=randomString(64); const challenge=base64url(await sha256(verifier)); return {verifier,challenge};
}
function redirect(url:string,headers:Record<string,string>={}){return new Response(null,{status:302,headers:{Location:url,...headers}});}
async function currentUser(request:Request,env:Env){
  const s=await readSession(request,env); if(!s)return null;
  const u=await env.DB.prepare("SELECT * FROM users WHERE id=? AND active=1").bind(s.uid).first<any>();
  return u||null;
}
function requireRole(user:any,roles:string[]){return user && roles.includes(user.role);}
async function audit(env:Env,user:any,action:string,entityType:string,entityId:string,before:any=null,after:any=null){
  await env.DB.prepare(`INSERT INTO audit_log(actor_user_id,actor_google_sub,actor_email,action,entity_type,entity_id,before_json,after_json)
    VALUES(?,?,?,?,?,?,?,?)`).bind(user?.id||null,user?.google_sub||null,user?.email||null,action,entityType,entityId,before?JSON.stringify(before):null,after?JSON.stringify(after):null).run();
}
function reportNo(){const d=new Date();return `SIR-${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}-${randomString(4).toUpperCase()}`;}
async function sendEmail(env:Env,to:string,subject:string,text:string,html:string){
  if(!env.EMAIL?.send)return;
  try{await env.EMAIL.send({to,from:env.EMAIL_FROM,subject,text,html});}catch(e){console.error("email",e);}
}
function htmlPage(title:string,body:string){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"></head><body>${body}</body></html>`;}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    try{
      if(url.pathname.startsWith("/auth/")) return await auth(request,env,url);
      if(url.pathname.startsWith("/api/")) return await api(request,env,url);
      if(url.pathname==="/health") return json({ok:true,service:"sir"});
      const asset=await env.ASSETS.fetch(request);
      return asset.status===404 ? env.ASSETS.fetch(new Request(new URL("/",url),request)) : asset;
    }catch(e){console.error(e);return bad("Internal server error",500);}
  }
} satisfies ExportedHandler<Env>;

async function auth(request:Request,env:Env,url:URL){
  if(url.pathname==="/auth/login"){
    const {verifier,challenge}=await pkce(); const state=randomString(32),nonce=randomString(32);
    await env.DB.prepare("INSERT INTO oauth_states(state,code_verifier,nonce,created_at) VALUES(?,?,?,?)").bind(state,verifier,nonce,Date.now()).run();
    const p=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:`${env.APP_URL}/auth/callback`,response_type:"code",scope:"openid email profile",state,nonce,code_challenge:challenge,code_challenge_method:"S256",access_type:"online",prompt:"select_account"});
    return redirect("https://accounts.google.com/o/oauth2/v2/auth?"+p);
  }
  if(url.pathname==="/auth/logout"){
    return redirect("/",{"Set-Cookie":cookie("",0)});
  }
  if(url.pathname==="/auth/callback"){
    const code=url.searchParams.get("code"),state=url.searchParams.get("state"); if(!code||!state)return bad("Missing OAuth response",400);
    const st=await env.DB.prepare("SELECT * FROM oauth_states WHERE state=?").bind(state).first<any>(); if(!st)return bad("Invalid OAuth state",400);
    await env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state).run();
    const token=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:`${env.APP_URL}/auth/callback`,grant_type:"authorization_code",code_verifier:st.code_verifier})});
    if(!token.ok)return bad("Google token exchange failed",401);
    const tok=await token.json<any>(); const info=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:`Bearer ${tok.access_token}`}});
    if(!info.ok)return bad("Google identity lookup failed",401);
    const g=await info.json<any>(); const email=(g.email||"").toLowerCase();
    if(!g.email_verified)return bad("Google email is not verified",403);
    let user=await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<any>();
    if(!user && email===env.BOOTSTRAP_SUPER_ADMIN_EMAIL.toLowerCase()){
      await env.DB.prepare("INSERT INTO users(google_sub,email,name,company,role,active) VALUES(?,?,?,?,?,1)").bind(g.sub,email,g.name||email,"PSA","super_admin").run();
      user=await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<any>();
    }
    if(!user || !user.active)return bad("Your Google account is not authorized for SIR.",403);
    if(user.google_sub && user.google_sub!==g.sub)return bad("Google identity does not match the authorized SIR account.",403);
    await env.DB.prepare("UPDATE users SET google_sub=?,name=?,last_login_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(g.sub,g.name||user.name,user.id).run();
    const session=await signSession({uid:user.id,sub:g.sub,exp:Date.now()+8*60*60*1000},env.SESSION_SECRET);
    return redirect("/",{"Set-Cookie":cookie(session,8*60*60)});
  }
  return bad("Not found",404);
}

async function api(request:Request,env:Env,url:URL){
  const user=await currentUser(request,env);
  const path=url.pathname;

  if(path==="/api/me"){
    return user?json({user:{id:user.id,email:user.email,name:user.name,company:user.company,role:user.role}}):json({user:null});
  }
  if(path==="/api/config"){
    const [c,l,a]=await Promise.all([
      env.DB.prepare("SELECT id,name FROM companies WHERE active=1 ORDER BY name").all(),
      env.DB.prepare("SELECT id,name FROM locations WHERE active=1 ORDER BY name").all(),
      env.DB.prepare("SELECT id,name FROM areas WHERE active=1 ORDER BY name").all()
    ]);
    return json({companies:c.results,locations:l.results,areas:a.results,findingTypes:[
      ["safe_good_practice","Safe / Good Practice"],["unsafe_act","Unsafe Act"],["unsafe_condition","Unsafe Condition"],["improvement_opportunity","Improvement Opportunity"]
    ]});
  }
  if(!user)return bad("Authentication required",401);

  if(path==="/api/reports" && request.method==="GET"){
    const isAdmin=requireRole(user,["admin","super_admin"]);
    if(isAdmin){
      const q=url.searchParams.get("q")||"",company=url.searchParams.get("company")||"",location=url.searchParams.get("location")||"",status=url.searchParams.get("status")||"";
      let sql=`SELECT r.*,u.email AS owner_email,(SELECT COUNT(*) FROM inspection_items i WHERE i.report_id=r.id) item_count
        FROM inspection_reports r JOIN users u ON u.id=r.created_by_user_id WHERE 1=1`;
      const args:any[]=[];
      if(q){sql+=" AND (r.report_no LIKE ? OR r.inspector_name LIKE ?)";args.push(`%${q}%`,`%${q}%`);}
      if(company){sql+=" AND r.company=?";args.push(company);} if(location){sql+=" AND r.location=?";args.push(location);} if(status){sql+=" AND r.status=?";args.push(status);}
      sql+=" ORDER BY r.created_at DESC LIMIT 200";
      return json(await env.DB.prepare(sql).bind(...args).all());
    }
    return json(await env.DB.prepare(`SELECT r.*, (SELECT COUNT(*) FROM inspection_items i WHERE i.report_id=r.id) item_count
      FROM inspection_reports r WHERE r.created_by_google_sub=? ORDER BY r.created_at DESC LIMIT 200`).bind(user.google_sub).all());
  }

  if(path==="/api/reports" && request.method==="POST"){
    const body=await request.json<any>();
    if(!body.inspection_date||!body.company||!body.location||!Array.isArray(body.items)||!body.items.length)return bad("Missing required inspection fields.");
    for(const item of body.items){
      if(!FINDING_TYPES.has(item.finding_type)||!item.area||!item.description)return bad("Each item needs Finding Type, Area and Description.");
      if(item.finding_type!=="safe_good_practice" && (!item.corrective_action||!item.target_date))return bad("Corrective Action and Target Date are required for non-safe findings.");
    }
    const newReportNo=reportNo();
    const ins=await env.DB.prepare(`INSERT INTO inspection_reports(report_no,inspection_date,inspector_name,company,location,created_by_user_id,created_by_google_sub,status)
      VALUES(?,?,?,?,?,?,?,'submitted')`).bind(newReportNo,body.inspection_date,user.name,body.company,body.location,user.id,user.google_sub).run();
    const reportId=Number(ins.meta.last_row_id);
    for(let n=0;n<body.items.length;n++){
      const x=body.items[n]; const safe=x.finding_type==="safe_good_practice";
      const r=await env.DB.prepare(`INSERT INTO inspection_items(report_id,item_no,finding_type,area,description,immediate_action,corrective_action,responsible_company,responsible_user_id,responsible_person_name,target_date,remark,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(reportId,n+1,x.finding_type,x.area,x.description,x.immediate_action||null,safe?null:x.corrective_action||null,safe?null:x.responsible_company||null,safe?null:x.responsible_user_id||null,safe?null:x.responsible_person_name||null,safe?null:x.target_date||null,x.remark||null,safe?"closed":"open").run();
      const itemId=Number(r.meta.last_row_id);
      await audit(env,user,"CREATE_ITEM","inspection_item",String(itemId),null,x);
    }
    await audit(env,user,"SUBMIT_REPORT","inspection_report",String(reportId),null,{reportNo:newReportNo});
    const unsafe=body.items.filter((x:any)=>x.finding_type!=="safe_good_practice").length;
    await sendEmail(env,env.ADMIN_NOTIFICATION_EMAIL,`New Safety Inspection – ${newReportNo}`,
      `A new safety inspection was submitted.\nReport: ${newReportNo}\nInspector: ${user.name}\nCompany: ${body.company}\nLocation: ${body.location}\nFindings: ${body.items.length}\nNon-safe findings: ${unsafe}\n`,
      `<h2>New Safety Inspection</h2><p><b>${esc(newReportNo)}</b></p><p>Inspector: ${esc(user.name)}<br>Company: ${esc(body.company)}<br>Location: ${esc(body.location)}</p><p>Findings: ${body.items.length}<br>Non-safe findings: ${unsafe}</p>`);
    return json({ok:true,reportId,reportNo:newReportNo});
  }

  const m=path.match(/^\/api\/reports\/(\d+)$/);
  if(m && request.method==="GET"){
    const id=Number(m[1]); const r=await env.DB.prepare("SELECT * FROM inspection_reports WHERE id=?").bind(id).first<any>(); if(!r)return bad("Report not found",404);
    if(r.created_by_google_sub!==user.google_sub&&!requireRole(user,["admin","super_admin"]))return bad("Access denied",403);
    const items=await env.DB.prepare("SELECT i.*,u.email AS responsible_email FROM inspection_items i LEFT JOIN users u ON u.id=i.responsible_user_id WHERE i.report_id=? ORDER BY i.item_no").bind(id).all();
    const photos=await env.DB.prepare("SELECT id,item_id,photo_type,original_name,content_type,size_bytes,created_at,uploaded_by_user_id FROM photos WHERE report_id=? ORDER BY id").bind(id).all();
    return json({report:r,items:items.results,photos:photos.results});
  }

  const pm=path.match(/^\/api\/photos\/(\d+)$/);
  if(pm && request.method==="GET"){
    const id=Number(pm[1]); const p=await env.DB.prepare("SELECT * FROM photos WHERE id=?").bind(id).first<any>(); if(!p)return bad("Photo not found",404);
    const r=await env.DB.prepare("SELECT created_by_google_sub FROM inspection_reports WHERE id=?").bind(p.report_id).first<any>();
    const allowed=r?.created_by_google_sub===user.google_sub||requireRole(user,["admin","super_admin"])||await env.DB.prepare("SELECT 1 FROM inspection_items WHERE id=? AND responsible_user_id=?").bind(p.item_id,user.id).first();
    if(!allowed)return bad("Access denied",403);
    const obj=await env.PHOTOS.get(p.r2_key); if(!obj)return bad("Photo missing",404);
    return new Response(obj.body,{headers:{"content-type":p.content_type,"cache-control":"private, max-age=300"}});
  }

  const im=path.match(/^\/api\/items\/(\d+)\/update$/);
  if(im && request.method==="POST"){
    const itemId=Number(im[1]); const item=await env.DB.prepare("SELECT * FROM inspection_items WHERE id=?").bind(itemId).first<any>(); if(!item)return bad("Item not found",404);
    const report=await env.DB.prepare("SELECT * FROM inspection_reports WHERE id=?").bind(item.report_id).first<any>();
    const allowed=item.responsible_user_id===user.id||requireRole(user,["admin","super_admin"]);
    if(!allowed)return bad("Only the assigned user or Admin can update this corrective action.",403);
    if(item.finding_type==="safe_good_practice")return bad("Safe findings do not require corrective-action updates.");
    const b=await request.json<any>(); if(!ACTION_STATUSES.has(b.status)||!b.remark)return bad("Status and update remark are required.");
    const before={status:item.status}; await env.DB.prepare("UPDATE inspection_items SET status=? WHERE id=?").bind(b.status,itemId).run();
    await env.DB.prepare("INSERT INTO action_updates(item_id,user_id,status,remark) VALUES(?,?,?,?)").bind(itemId,user.id,b.status,b.remark).run();
    await audit(env,user,"UPDATE_ACTION","inspection_item",String(itemId),before,{status:b.status,remark:b.remark});
    if(b.status==="closure_requested"){
      await sendEmail(env,env.ADMIN_NOTIFICATION_EMAIL,`Closure Verification Required – ${report.report_no}`,
        `Item ${item.item_no} has requested closure.\nUpdated by: ${user.name}\nRemark: ${b.remark}`,
        `<h2>Closure Verification Required</h2><p>Report ${esc(report.report_no)}, Item ${item.item_no}</p><p>${esc(b.remark)}</p>`);
    }
    return json({ok:true});
  }

  const cm=path.match(/^\/api\/items\/(\d+)\/closure$/);
  if(cm && request.method==="POST"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    const id=Number(cm[1]); const item=await env.DB.prepare("SELECT * FROM inspection_items WHERE id=?").bind(id).first<any>(); if(!item)return bad("Item not found",404);
    const b=await request.json<any>(); if(!["approve","reject"].includes(b.decision))return bad("Invalid decision");
    const newStatus=b.decision==="approve"?"closed":"rejected";
    await env.DB.prepare("UPDATE inspection_items SET status=? WHERE id=?").bind(newStatus,id).run();
    await audit(env,user,b.decision==="approve"?"APPROVE_CLOSURE":"REJECT_CLOSURE","inspection_item",String(id),{status:item.status},{status:newStatus,remark:b.remark||null});
    const report=await env.DB.prepare("SELECT report_no FROM inspection_reports WHERE id=?").bind(item.report_id).first<any>();
    await sendEmail(env,env.ADMIN_NOTIFICATION_EMAIL,`Safety Action ${newStatus.toUpperCase()} – ${report?.report_no||""}`,
      `Item ${item.item_no}: ${newStatus}.\nAdmin: ${user.name}\n${b.remark||""}`,
      `<h2>Safety Action ${esc(newStatus.toUpperCase())}</h2><p>Item ${item.item_no}</p><p>${esc(b.remark||"")}</p>`);
    return json({ok:true,status:newStatus});
  }

  const um=path.match(/^\/api\/items\/(\d+)\/photos$/);
  if(um && request.method==="POST"){
    const itemId=Number(um[1]); const item=await env.DB.prepare("SELECT * FROM inspection_items WHERE id=?").bind(itemId).first<any>(); if(!item)return bad("Item not found",404);
    const allowed=item.responsible_user_id===user.id||requireRole(user,["admin","super_admin"]);
    if(!allowed)return bad("Only the assigned user or Admin can upload action photos.",403);
    const form=await request.formData(); const file=form.get("file"); const photoType=String(form.get("photo_type")||"update");
    if(!(file instanceof File))return bad("Photo file required"); if(!["update","closure"].includes(photoType))return bad("Invalid photo type");
    if(file.size>MAX_PHOTO_BYTES)return bad("Photo exceeds 8 MB limit"); if(!ALLOWED_TYPES.has(file.type))return bad("Unsupported photo type");
    const count=await env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE item_id=? AND photo_type=?").bind(itemId,photoType).first<any>();
    if(Number(count?.n||0)>=MAX_PHOTOS_PER_ITEM)return bad("Photo limit reached");
    const key=`reports/${item.report_id}/items/${itemId}/${photoType}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
    await env.PHOTOS.put(key,file.stream(),{httpMetadata:{contentType:file.type}});
    await env.DB.prepare("INSERT INTO photos(report_id,item_id,photo_type,r2_key,original_name,content_type,size_bytes,uploaded_by_user_id) VALUES(?,?,?,?,?,?,?,?)")
      .bind(item.report_id,itemId,photoType,key,file.name,file.type,file.size,user.id).run();
    await audit(env,user,"UPLOAD_PHOTO","photo",key,null,{itemId,photoType});
    return json({ok:true});
  }

  if(path==="/api/admin/users" && request.method==="GET"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    return json(await env.DB.prepare("SELECT id,email,name,company,role,active,created_at,last_login_at FROM users ORDER BY name").all());
  }
  if(path==="/api/admin/users" && request.method==="POST"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    const b=await request.json<any>(); if(!b.email||!b.name||!["inspector","action_user","admin","super_admin"].includes(b.role))return bad("Invalid user");
    await env.DB.prepare("INSERT INTO users(email,name,company,role,active) VALUES(?,?,?,?,1)").bind(b.email.toLowerCase(),b.name,b.company||null,b.role).run();
    await audit(env,user,"CREATE_USER","user",b.email,null,b); return json({ok:true});
  }
  const userm=path.match(/^\/api\/admin\/users\/(\d+)$/);
  if(userm && request.method==="PATCH"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    const id=Number(userm[1]), b=await request.json<any>(); const target=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first<any>(); if(!target)return bad("User not found",404);
    if(user.role!=="super_admin" && b.role==="super_admin")return bad("Only Super Admin can grant Super Admin.",403);
    if(target.role==="super_admin"&&b.active===0){
      const c=await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='super_admin' AND active=1").first<any>(); if(Number(c?.n||0)<=1)return bad("Cannot deactivate the last Super Admin.",400);
    }
    await env.DB.prepare("UPDATE users SET name=?,company=?,role=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(b.name,target.company,b.role,Number(b.active),id).run();
    await audit(env,user,"UPDATE_USER","user",String(id),target,b); return json({ok:true});
  }

  if(path==="/api/admin/settings" && request.method==="GET"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    const [companies,locations,areas]=await Promise.all([
      env.DB.prepare("SELECT * FROM companies ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM locations ORDER BY name").all(),
      env.DB.prepare("SELECT * FROM areas ORDER BY name").all()
    ]); return json({companies:companies.results,locations:locations.results,areas:areas.results});
  }
  const sm=path.match(/^\/api\/admin\/settings\/(companies|locations|areas)$/);
  if(sm && request.method==="POST"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    const table=sm[1],b=await request.json<any>(); if(!b.name)return bad("Name required");
    await env.DB.prepare(`INSERT INTO ${table}(name,active,created_by) VALUES(?,?,?)`).bind(b.name.trim(),1,user.id).run();
    await audit(env,user,"CREATE_SETTING",table,b.name,null,b); return json({ok:true});
  }
  const sx=path.match(/^\/api\/admin\/settings\/(companies|locations|areas)\/(\d+)$/);
  if(sx && request.method==="PATCH"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    const table=sx[1],id=Number(sx[2]),b=await request.json<any>(); const old=await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first<any>();
    if(!old)return bad("Setting not found",404);
    await env.DB.prepare(`UPDATE ${table} SET name=?,active=? WHERE id=?`).bind(b.name||old.name,Number(b.active),id).run();
    await audit(env,user,"UPDATE_SETTING",table,String(id),old,b); return json({ok:true});
  }
  if(path==="/api/admin/audit" && request.method==="GET"){
    if(!requireRole(user,["admin","super_admin"]))return bad("Admin access required",403);
    return json(await env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 500").all());
  }

  return bad("API endpoint not found",404);
}
