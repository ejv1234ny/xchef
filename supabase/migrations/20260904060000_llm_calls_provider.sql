-- 0008: llm_calls.provider — which API produced the call ('openai' | 'anthropic').
alter table llm_calls add column provider text not null default 'anthropic';
create index on llm_calls (provider, created_at desc);
