import OpenAI from "openai";
import {NORTH_STAR,TINKERBELL_SYSTEM} from "../../../lib/northstar";

function telegramApi(method){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  if(!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  return `https://api.telegram.org/bot${token}/${method}`;
}

function normalizeOrigin(value){
  if(!value) return null;
  return value.startsWith("http://")||value.startsWith("https://") ? value.replace(/\/$/,"") : `https://${value.replace(/\/$/,"")}`;
}

function getPublicOrigin(req){
  const vercelProduction=normalizeOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if(vercelProduction) return {origin:vercelProduction,source:"VERCEL_PROJECT_PRODUCTION_URL"};

  const vercelUrl=normalizeOrigin(process.env.VERCEL_URL);
  if(vercelUrl) return {origin:vercelUrl,source:"VERCEL_URL"};

  const forwardedHost=req.headers.get("x-forwarded-host")||req.headers.get("host");
  if(forwardedHost){
    const proto=req.headers.get("x-forwarded-proto")||"https";
    return {origin:`${proto}://${forwardedHost}`,source:"request_headers"};
  }

  return {origin:new URL(req.url).origin,source:"request_url"};
}

async function sendTelegram(chatId,text){
  const res=await fetch(telegramApi("sendMessage"),{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text})
  });
  if(!res.ok) throw new Error(`Telegram send failed: ${res.status}`);
}

function commandPrompt(text){
  if(text==="/today") return "오늘 매출과 신규 해외 고객 확보에 가장 가까운 액션 3개를 우선순위, 이유, 완료 기준으로 제시해줘.";
  if(text==="/goal") return `북극성 지표는 ${NORTH_STAR.primaryMetric}이다. 이번주 KPI 체크리스트와 수치 입력 양식을 보여줘.`;
  if(text==="/leads") return "오늘 해외 신규 리드 발굴과 기존 미응답 리드 팔로업을 어떤 순서로 실행할지 계획해줘.";
  if(text.startsWith("/country ")) return `${text.replace("/country ","")} 시장 공략을 위한 고객 세그먼트, 채널, 오퍼, 메시지, 7일 실행계획을 만들어줘.`;
  return text;
}

export async function GET(req){
  try{
    const {origin,source}=getPublicOrigin(req);
    const webhookUrl=`${origin}/api/telegram`;

    const url=new URL(req.url);
    if(url.searchParams.get("mode")==="status"){
      const infoRes=await fetch(telegramApi("getWebhookInfo"));
      const info=await infoRes.json();
      return Response.json({
        ok:Boolean(info?.ok),
        public_origin:origin,
        address_source:source,
        expected_webhook_url:webhookUrl,
        telegram_webhook_url:info?.result?.url||null,
        pending_update_count:info?.result?.pending_update_count??null,
        last_error_message:info?.result?.last_error_message||null
      });
    }

    const payload={url:webhookUrl,allowed_updates:["message"]};
    if(process.env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token=process.env.TELEGRAM_WEBHOOK_SECRET;

    const res=await fetch(telegramApi("setWebhook"),{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(payload)
    });
    const data=await res.json();
    if(!res.ok||!data.ok) return Response.json({ok:false,step:"setWebhook",telegram:data},{status:500});

    return Response.json({
      ok:true,
      message:"Tinkerbell Telegram webhook connected",
      public_origin:origin,
      address_source:source,
      webhook_url:webhookUrl
    });
  }catch(error){
    console.error(error);
    return Response.json({ok:false,error:"telegram_webhook_setup_failed"},{status:500});
  }
}

export async function POST(req){
  try{
    const secret=req.headers.get("x-telegram-bot-api-secret-token");
    if(process.env.TELEGRAM_WEBHOOK_SECRET&&secret!==process.env.TELEGRAM_WEBHOOK_SECRET) return Response.json({ok:false},{status:401});
    const update=await req.json();
    const message=update.message;
    if(!message?.chat?.id||!message?.text) return Response.json({ok:true});
    const chatId=String(message.chat.id);
    const allowed=process.env.TELEGRAM_ALLOWED_CHAT_ID;
    if(allowed&&chatId!==String(allowed)){
      await sendTelegram(chatId,"이 봇은 대표 전용 팅커벨입니다.");
      return Response.json({ok:true});
    }
    if(!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const result=await client.responses.create({
      model:process.env.OPENAI_MODEL||"gpt-5.6-luna",
      instructions:TINKERBELL_SYSTEM,
      input:commandPrompt(message.text.trim())
    });
    await sendTelegram(chatId,(result.output_text||"응답을 만들지 못했습니다.").slice(0,3900));
    return Response.json({ok:true});
  }catch(error){
    console.error(error);
    return Response.json({ok:false,error:"telegram_handler_failed"},{status:500});
  }
}
