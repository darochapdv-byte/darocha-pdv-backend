import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logOperation } from '../../shared/operationalLog.ts';

// Limite para considerar uma sessão "inativa" (sem heartbeat) e permitir
// recuperação inteligente em outro dispositivo sem bloquear o operador.
const INACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutos

// Abertura de caixa com validação anti-duplicação no backend.
// Regras:
// - Cada operador só pode ter UM caixa aberto por dispositivo/terminal.
// - Se já existir um caixa aberto para o operador NO MESMO dispositivo => retoma (não duplica).
// - Se já existir um caixa aberto para o operador EM OUTRO dispositivo => bloqueia.
// - Caso contrário => cria um novo caixa.
// A checagem + criação rodam no servidor, impedindo duplicações mesmo em
// atualização de página, perda de conexão ou acesso simultâneo.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const operator_id = body.operator_id;
    const operator_name = body.operator_name;
    const device_id = body.device_id;

    if (!operator_id) return Response.json({ error: 'Selecione o funcionário.' }, { status: 400 });
    if (!device_id) return Response.json({ error: 'Dispositivo não identificado.' }, { status: 400 });

    // 1) Caixas abertos para este OPERADOR (regra: um operador = no máximo um caixa aberto).
    const existingOperator = await base44.entities.CashSession.filter(
      { operator_id, status: 'aberto' },
      '-created_date',
      50
    );
    // Mesmo dispositivo (ou caixa antigo sem device_id) => retomar sessão existente (nunca duplicar).
    const sameDevice = (existingOperator || []).find((s) => !s.device_id || s.device_id === device_id);
    if (sameDevice) {
      // Vincula caixas antigos (sem device_id) a este dispositivo para futuras retomadas.
      if (!sameDevice.device_id) {
        await base44.entities.CashSession.update(sameDevice.id, { device_id });
      }
      return Response.json({ session: sameDevice, resumed: true });
    }
    // Operador com caixa aberto em OUTRO dispositivo.
    // Recuperação inteligente: se a sessão estiver inativa (sem heartbeat há
    // mais de INACTIVE_THRESHOLD_MS), permite assumi-la neste dispositivo em
    // vez de bloquear — evita travar o operador quando o terminal original
    // sumiu (bateria, fechou a aba, etc.). Caso contrário, bloqueia.
    if (existingOperator && existingOperator.length > 0) {
      const prev = existingOperator[0];
      const lastActive = prev.last_active_at || prev.created_date;
      const stale = !lastActive || (Date.now() - new Date(lastActive).getTime()) > INACTIVE_THRESHOLD_MS;
      if (stale || prev.inactive) {
        const now = new Date().toISOString();
        await base44.entities.CashSession.update(prev.id, {
          device_id,
          inactive: false,
          last_active_at: now,
        });
        await logOperation(base44, {
          type: 'cash_recovery', level: 'warn',
          description: `Caixa inativo ${prev.id} recuperado automaticamente (sem heartbeat desde ${lastActive || 'nunca'}).`,
          operator_name: operator_name || '', device_id, cash_session_id: prev.id,
        });
        return Response.json({ session: { ...prev, device_id, inactive: false, last_active_at: now }, resumed: true, inactive_recovery: true });
      }
      return Response.json({
        blocked: true,
        error: `Este funcionário já possui um caixa aberto em outro dispositivo${prev?.terminal ? ` (${prev.terminal})` : ''}. Feche o caixa atual ou aguarde a inatividade para assumi-lo.`,
      });
    }

    // 2) Este DISPOSITIVO/TERMINAL já tem caixa aberto por outro operador => bloqueia
    //    (regra: um terminal = no máximo um caixa aberto por vez).
    const existingDevice = await base44.entities.CashSession.filter(
      { device_id, status: 'aberto' },
      '-created_date',
      50
    );
    if (existingDevice && existingDevice.length > 0) {
      const prev = existingDevice[0];
      return Response.json({
        blocked: true,
        error: `Este terminal já possui um caixa aberto por ${prev?.operator_name || 'outro funcionário'}. Feche o caixa atual antes de abrir outro.`,
      });
    }

    // Nenhum caixa aberto => criar novo.
    const operatorIsVendedor = Array.isArray(body.operator_funcoes) && body.operator_funcoes.includes('vendedor');
    const session = await base44.entities.CashSession.create({
      opening_amount: Number(body.opening_amount) || 0,
      operator_id,
      operator_name: operator_name || '',
      operator_funcoes: body.operator_funcoes || [],
      device_id,
      seller_id: operatorIsVendedor ? operator_id : '',
      seller_control_mode: operatorIsVendedor ? 'sem_vendedores' : 'com_vendedores',
      commission_percent: operatorIsVendedor ? Number(body.commission_percent) || 0 : 0,
      terminal: body.terminal || '',
      status: 'aberto',
    });

    return Response.json({ session, resumed: false });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});