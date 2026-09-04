// Generated from Supabase project gqahyzoebifscqcrrkgq via `pnpm db:types`. Do not edit.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      inventory_items: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"]
          category: string | null
          cost_per_base_unit: number | null
          created_at: string
          id: string
          name: string
          pack_to_base_factor: number | null
          tenant_id: string
        }
        Insert: {
          base_unit: Database["public"]["Enums"]["uom"]
          category?: string | null
          cost_per_base_unit?: number | null
          created_at?: string
          id?: string
          name: string
          pack_to_base_factor?: number | null
          tenant_id: string
        }
        Update: {
          base_unit?: Database["public"]["Enums"]["uom"]
          category?: string | null
          cost_per_base_unit?: number | null
          created_at?: string
          id?: string
          name?: string
          pack_to_base_factor?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_documents: {
        Row: {
          content_hash: string | null
          created_at: string
          email_from: string | null
          email_message_id: string | null
          email_subject: string | null
          id: string
          invoice_date: string | null
          invoice_number: string | null
          location_id: string
          parse_confidence: number | null
          parse_error: string | null
          posted_at: string | null
          raw_extraction: Json | null
          received_date: string | null
          source: Database["public"]["Enums"]["invoice_source"]
          status: Database["public"]["Enums"]["invoice_status"]
          storage_path: string
          subtotal: number | null
          tax: number | null
          total: number | null
          vendor_id: string | null
        }
        Insert: {
          content_hash?: string | null
          created_at?: string
          email_from?: string | null
          email_message_id?: string | null
          email_subject?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          location_id: string
          parse_confidence?: number | null
          parse_error?: string | null
          posted_at?: string | null
          raw_extraction?: Json | null
          received_date?: string | null
          source?: Database["public"]["Enums"]["invoice_source"]
          status?: Database["public"]["Enums"]["invoice_status"]
          storage_path: string
          subtotal?: number | null
          tax?: number | null
          total?: number | null
          vendor_id?: string | null
        }
        Update: {
          content_hash?: string | null
          created_at?: string
          email_from?: string | null
          email_message_id?: string | null
          email_subject?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          location_id?: string
          parse_confidence?: number | null
          parse_error?: string | null
          posted_at?: string | null
          raw_extraction?: Json | null
          received_date?: string | null
          source?: Database["public"]["Enums"]["invoice_source"]
          status?: Database["public"]["Enums"]["invoice_status"]
          storage_path?: string
          subtotal?: number | null
          tax?: number | null
          total?: number | null
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          ai_category_guess: string | null
          ai_confidence: number | null
          cost_per_base_unit: number | null
          created_at: string
          description: string
          extended_price: number | null
          id: string
          inventory_item_id: string | null
          invoice_id: string
          line_no: number
          mapping_id: string | null
          pack_size_text: string | null
          quantity: number
          quantity_base_unit: number | null
          status: Database["public"]["Enums"]["invoice_line_status"]
          unit_price: number | null
          vendor_sku: string | null
        }
        Insert: {
          ai_category_guess?: string | null
          ai_confidence?: number | null
          cost_per_base_unit?: number | null
          created_at?: string
          description: string
          extended_price?: number | null
          id?: string
          inventory_item_id?: string | null
          invoice_id: string
          line_no: number
          mapping_id?: string | null
          pack_size_text?: string | null
          quantity: number
          quantity_base_unit?: number | null
          status?: Database["public"]["Enums"]["invoice_line_status"]
          unit_price?: number | null
          vendor_sku?: string | null
        }
        Update: {
          ai_category_guess?: string | null
          ai_confidence?: number | null
          cost_per_base_unit?: number | null
          created_at?: string
          description?: string
          extended_price?: number | null
          id?: string
          inventory_item_id?: string | null
          invoice_id?: string
          line_no?: number
          mapping_id?: string | null
          pack_size_text?: string | null
          quantity?: number
          quantity_base_unit?: number | null
          status?: Database["public"]["Enums"]["invoice_line_status"]
          unit_price?: number | null
          vendor_sku?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "item_price_history"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "invoice_lines_mapping_id_fkey"
            columns: ["mapping_id"]
            isOneToOne: false
            referencedRelation: "vendor_item_mappings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_mapping_id_fkey"
            columns: ["mapping_id"]
            isOneToOne: false
            referencedRelation: "vendor_price_comparison"
            referencedColumns: ["mapping_id"]
          },
          {
            foreignKeyName: "invoice_lines_mapping_id_fkey"
            columns: ["mapping_id"]
            isOneToOne: false
            referencedRelation: "vendor_price_latest"
            referencedColumns: ["mapping_id"]
          },
        ]
      }
      llm_calls: {
        Row: {
          cost_usd: number | null
          created_at: string
          error: string | null
          id: string
          input_tokens: number
          kind: string
          model: string
          output_tokens: number
          raw: Json | null
          ref_id: string | null
          tenant_id: string
        }
        Insert: {
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          id?: string
          input_tokens?: number
          kind: string
          model: string
          output_tokens?: number
          raw?: Json | null
          ref_id?: string | null
          tenant_id: string
        }
        Update: {
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          id?: string
          input_tokens?: number
          kind?: string
          model?: string
          output_tokens?: number
          raw?: Json | null
          ref_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_calls_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          created_at: string
          id: string
          inbound_email_slug: string | null
          name: string
          tenant_id: string
          timezone: string
          toast_location_guid: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          inbound_email_slug?: string | null
          name: string
          tenant_id: string
          timezone?: string
          toast_location_guid?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          inbound_email_slug?: string | null
          name?: string
          tenant_id?: string
          timezone?: string
          toast_location_guid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "locations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          role: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          role?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_items: {
        Row: {
          category: string | null
          created_at: string
          id: string
          name: string
          price: number | null
          recipe_status: Database["public"]["Enums"]["recipe_status"]
          tenant_id: string
          toast_menu_item_guid: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          name: string
          price?: number | null
          recipe_status?: Database["public"]["Enums"]["recipe_status"]
          tenant_id: string
          toast_menu_item_guid?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          name?: string
          price?: number | null
          recipe_status?: Database["public"]["Enums"]["recipe_status"]
          tenant_id?: string
          toast_menu_item_guid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_components: {
        Row: {
          confidence: number | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          id: string
          inventory_item_id: string
          menu_item_id: string
          quantity: number
          source: Database["public"]["Enums"]["recipe_source"]
          unit: Database["public"]["Enums"]["uom"]
        }
        Insert: {
          confidence?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          inventory_item_id: string
          menu_item_id: string
          quantity: number
          source?: Database["public"]["Enums"]["recipe_source"]
          unit: Database["public"]["Enums"]["uom"]
        }
        Update: {
          confidence?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          inventory_item_id?: string
          menu_item_id?: string
          quantity?: number
          source?: Database["public"]["Enums"]["recipe_source"]
          unit?: Database["public"]["Enums"]["uom"]
        }
        Relationships: [
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_item_cost"
            referencedColumns: ["menu_item_id"]
          },
          {
            foreignKeyName: "recipe_components_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_facts: {
        Row: {
          business_date: string
          created_at: string
          id: string
          location_id: string
          menu_item_id: string | null
          net_sales: number | null
          quantity_sold: number
          quantity_voided: number
          synced_at: string
          toast_menu_item_guid: string | null
        }
        Insert: {
          business_date: string
          created_at?: string
          id?: string
          location_id: string
          menu_item_id?: string | null
          net_sales?: number | null
          quantity_sold: number
          quantity_voided?: number
          synced_at?: string
          toast_menu_item_guid?: string | null
        }
        Update: {
          business_date?: string
          created_at?: string
          id?: string
          location_id?: string
          menu_item_id?: string | null
          net_sales?: number | null
          quantity_sold?: number
          quantity_voided?: number
          synced_at?: string
          toast_menu_item_guid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_item_cost"
            referencedColumns: ["menu_item_id"]
          },
          {
            foreignKeyName: "sales_facts_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_counts: {
        Row: {
          count_date: string
          counted_at: string
          counted_by: string | null
          created_at: string
          estimate_at_count: number | null
          id: string
          inventory_item_id: string
          location_id: string
          note: string | null
          position: Database["public"]["Enums"]["count_position"]
          quantity_base_unit: number
          verification: Database["public"]["Enums"]["verification_type"]
        }
        Insert: {
          count_date: string
          counted_at?: string
          counted_by?: string | null
          created_at?: string
          estimate_at_count?: number | null
          id?: string
          inventory_item_id: string
          location_id: string
          note?: string | null
          position?: Database["public"]["Enums"]["count_position"]
          quantity_base_unit: number
          verification?: Database["public"]["Enums"]["verification_type"]
        }
        Update: {
          count_date?: string
          counted_at?: string
          counted_by?: string | null
          created_at?: string
          estimate_at_count?: number | null
          id?: string
          inventory_item_id?: string
          location_id?: string
          note?: string | null
          position?: Database["public"]["Enums"]["count_position"]
          quantity_base_unit?: number
          verification?: Database["public"]["Enums"]["verification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          created_at: string
          dates_rebuilt: string[]
          duration_ms: number | null
          error: string | null
          id: string
          kind: string
          location_id: string
          orders_fetched: number
          orders_quarantined: number
          orders_upserted: number
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          created_at?: string
          dates_rebuilt?: string[]
          duration_ms?: number | null
          error?: string | null
          id?: string
          kind?: string
          location_id: string
          orders_fetched?: number
          orders_quarantined?: number
          orders_upserted?: number
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          created_at?: string
          dates_rebuilt?: string[]
          duration_ms?: number | null
          error?: string | null
          id?: string
          kind?: string
          location_id?: string
          orders_fetched?: number
          orders_quarantined?: number
          orders_upserted?: number
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_runs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_runs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sync_runs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sync_runs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
        ]
      }
      tenants: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      toast_credentials: {
        Row: {
          client_id: string
          client_secret_encrypted: string
          created_at: string
          id: string
          last_synced_at: string | null
          location_id: string
        }
        Insert: {
          client_id: string
          client_secret_encrypted: string
          created_at?: string
          id?: string
          last_synced_at?: string | null
          location_id: string
        }
        Update: {
          client_id?: string
          client_secret_encrypted?: string
          created_at?: string
          id?: string
          last_synced_at?: string | null
          location_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "toast_credentials_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "toast_credentials_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "toast_credentials_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "toast_credentials_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
        ]
      }
      toast_orders_raw: {
        Row: {
          business_date: string
          location_id: string
          modified_date: string
          order_guid: string
          payload: Json
          synced_at: string
          voided: boolean
        }
        Insert: {
          business_date: string
          location_id: string
          modified_date: string
          order_guid: string
          payload: Json
          synced_at?: string
          voided?: boolean
        }
        Update: {
          business_date?: string
          location_id?: string
          modified_date?: string
          order_guid?: string
          payload?: Json
          synced_at?: string
          voided?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "toast_orders_raw_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "toast_orders_raw_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "toast_orders_raw_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "toast_orders_raw_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
        ]
      }
      vendor_item_mappings: {
        Row: {
          base_units_per_unit: number
          brand: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          description_norm: string
          id: string
          inventory_item_id: string
          pack_description: string | null
          tenant_id: string
          units_per_pack: number
          vendor_id: string
          vendor_sku: string | null
        }
        Insert: {
          base_units_per_unit: number
          brand?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          description_norm: string
          id?: string
          inventory_item_id: string
          pack_description?: string | null
          tenant_id: string
          units_per_pack?: number
          vendor_id: string
          vendor_sku?: string | null
        }
        Update: {
          base_units_per_unit?: number
          brand?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          description_norm?: string
          id?: string
          inventory_item_id?: string
          pack_description?: string | null
          tenant_id?: string
          units_per_pack?: number
          vendor_id?: string
          vendor_sku?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_item_mappings_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          created_at: string
          email_domains: string[] | null
          id: string
          name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          email_domains?: string[] | null
          id?: string
          name: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          email_domains?: string[] | null
          id?: string
          name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      count_variance: {
        Row: {
          actual_qty: number | null
          count_date: string | null
          expected_qty: number | null
          inventory_item_id: string | null
          location_id: string | null
          position: Database["public"]["Enums"]["count_position"] | null
          prev_count_date: string | null
          prev_position: Database["public"]["Enums"]["count_position"] | null
          prev_qty: number | null
          purchased: number | null
          theoretical_used: number | null
          variance_packs: number | null
          variance_qty: number | null
          variance_value: number | null
          verification: Database["public"]["Enums"]["verification_type"] | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "stock_counts_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "stock_counts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
        ]
      }
      item_price_history: {
        Row: {
          cost_per_base_unit: number | null
          inventory_item_id: string | null
          invoice_id: string | null
          location_id: string | null
          quantity_base_unit: number | null
          received_date: string | null
          vendor_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
        ]
      }
      menu_item_cost: {
        Row: {
          all_costs_known: boolean | null
          category: string | null
          component_count: number | null
          cost_pct: number | null
          menu_item_id: string | null
          menu_item_name: string | null
          menu_price: number | null
          plate_cost: number | null
          recipe_confirmed: boolean | null
          recipe_status: Database["public"]["Enums"]["recipe_status"] | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      on_hand_estimate: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          has_baseline: boolean | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          last_count_date: string | null
          last_count_position:
            | Database["public"]["Enums"]["count_position"]
            | null
          last_count_qty: number | null
          last_verification:
            | Database["public"]["Enums"]["verification_type"]
            | null
          last_verified_at: string | null
          location_id: string | null
          on_hand_packs: number | null
          on_hand_qty: number | null
          on_hand_value: number | null
          pack_to_base_factor: number | null
          purchased_since: number | null
          used_since: number | null
        }
        Relationships: []
      }
      purchases_by_item: {
        Row: {
          cost: number | null
          inventory_item_id: string | null
          location_id: string | null
          quantity_base_unit: number | null
          received_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_documents_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
        ]
      }
      unit_cogs_master: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          category: string | null
          cost_on_file: number | null
          inventory_item_id: string | null
          latest_cost_per_base_unit: number | null
          latest_cost_per_pack: number | null
          latest_price_date: string | null
          latest_vendor_id: string | null
          name: string | null
          pack_to_base_factor: number | null
          tenant_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_documents_vendor_id_fkey"
            columns: ["latest_vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_by_menu_item: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          location_id: string | null
          menu_item_id: string | null
          menu_item_name: string | null
          quantity_used: number | null
          units_sold: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_item_cost"
            referencedColumns: ["menu_item_id"]
          },
          {
            foreignKeyName: "sales_facts_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_by_period: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          business_date: string | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          location_id: string | null
          quantity_used: number | null
          usage_cost: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "recipe_components_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "vendor_switch_savings"
            referencedColumns: ["location_id"]
          },
          {
            foreignKeyName: "sales_facts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["location_id"]
          },
        ]
      }
      vendor_price_comparison: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          base_units_per_pack: number | null
          best_cost_per_base_unit: number | null
          brand: string | null
          cost_per_base_unit: number | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          is_cheapest: boolean | null
          mapping_id: string | null
          option_count: number | null
          pack_description: string | null
          premium_pct: number | null
          premium_per_base_unit: number | null
          price_date: string | null
          price_per_pack: number | null
          tenant_id: string | null
          vendor_id: string | null
          vendor_name: string | null
          vendor_sku: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_price_latest: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          base_units_per_pack: number | null
          brand: string | null
          cost_per_base_unit: number | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          mapping_id: string | null
          pack_description: string | null
          price_date: string | null
          price_per_pack: number | null
          tenant_id: string | null
          vendor_id: string | null
          vendor_name: string | null
          vendor_sku: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "vendor_item_mappings_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_switch_savings: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          cheapest_cost: number | null
          cheapest_pack: string | null
          cheapest_vendor: string | null
          current_cost: number | null
          current_pack: string | null
          current_vendor: string | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          location_id: string | null
          premium_pct: number | null
          savings_30d: number | null
          savings_annualized: number | null
          used_30d: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "on_hand_estimate"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "unit_cogs_master"
            referencedColumns: ["inventory_item_id"]
          },
          {
            foreignKeyName: "invoice_lines_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "verification_queue"
            referencedColumns: ["inventory_item_id"]
          },
        ]
      }
      verification_queue: {
        Row: {
          base_unit: Database["public"]["Enums"]["uom"] | null
          category: string | null
          cost_per_base_unit: number | null
          daily_burn_value: number | null
          days_of_supply: number | null
          days_since_verified: number | null
          exposure_value: number | null
          has_baseline: boolean | null
          inventory_item_id: string | null
          inventory_item_name: string | null
          last_count_date: string | null
          last_verified_at: string | null
          location_id: string | null
          on_hand_packs: number | null
          on_hand_qty: number | null
          on_hand_value: number | null
          pack_to_base_factor: number | null
          price_change_30d: number | null
          priority_score: number | null
          reason: string | null
          tenant_id: string | null
          used_per_day: number | null
          value_per_pack: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      convert_factor: {
        Args: {
          from_unit: Database["public"]["Enums"]["uom"]
          to_unit: Database["public"]["Enums"]["uom"]
        }
        Returns: number
      }
      get_toast_client_secret: {
        Args: { p_location_id: string }
        Returns: string
      }
      my_location_ids: { Args: never; Returns: string[] }
      my_tenant_ids: { Args: never; Returns: string[] }
      relink_sales_facts: { Args: { p_location_id: string }; Returns: number }
      replace_sales_facts: {
        Args: { p_dates: string[]; p_location_id: string; p_rows: Json }
        Returns: number
      }
      set_toast_credentials: {
        Args: {
          p_client_id: string
          p_client_secret: string
          p_location_id: string
        }
        Returns: undefined
      }
    }
    Enums: {
      count_position: "open" | "close"
      invoice_line_status: "unmapped" | "auto_mapped" | "confirmed" | "ignored"
      invoice_source:
        | "email"
        | "forward"
        | "upload"
        | "paste"
        | "manual"
        | "api"
      invoice_status:
        | "received"
        | "parsing"
        | "needs_review"
        | "posted"
        | "rejected"
      recipe_source: "ai_draft" | "reverse_engineered" | "confirmed"
      recipe_status: "draft" | "needs_review" | "confirmed"
      uom:
        | "oz"
        | "ml"
        | "l"
        | "g"
        | "kg"
        | "lb"
        | "each"
        | "case"
        | "bottle"
        | "can"
      verification_type: "confirmed_estimate" | "counted"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      count_position: ["open", "close"],
      invoice_line_status: ["unmapped", "auto_mapped", "confirmed", "ignored"],
      invoice_source: ["email", "forward", "upload", "paste", "manual", "api"],
      invoice_status: [
        "received",
        "parsing",
        "needs_review",
        "posted",
        "rejected",
      ],
      recipe_source: ["ai_draft", "reverse_engineered", "confirmed"],
      recipe_status: ["draft", "needs_review", "confirmed"],
      uom: ["oz", "ml", "l", "g", "kg", "lb", "each", "case", "bottle", "can"],
      verification_type: ["confirmed_estimate", "counted"],
    },
  },
} as const
