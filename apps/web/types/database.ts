export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      residents: {
        Row: {
          id: string;
          resman_ledger_id: string;
          resman_login: string;
          name: string;
          unit_id: string;
          access_allowed: boolean;
          access_status: string | null;
          last_resman_verified_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          resman_ledger_id: string;
          resman_login: string;
          name: string;
          unit_id: string;
          access_allowed?: boolean;
          access_status?: string | null;
          last_resman_verified_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          resman_ledger_id?: string;
          resman_login?: string;
          name?: string;
          unit_id?: string;
          access_allowed?: boolean;
          access_status?: string | null;
          last_resman_verified_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      guest_passes: {
        Row: {
          id: string;
          resident_id: string;
          guest_name: string;
          guest_email: string;
          guest_phone: string | null;
          guest_address: string | null;
          share_token: string;
          expires_at: string;
          used_at: string | null;
          status: "active" | "revoked" | "used";
          email_delivery_status: "pending" | "sent" | "failed";
          email_provider_id: string | null;
          email_sent_at: string | null;
          email_last_error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          resident_id: string;
          guest_name: string;
          guest_email: string;
          guest_phone?: string | null;
          guest_address?: string | null;
          share_token: string;
          expires_at: string;
          used_at?: string | null;
          status?: "active" | "revoked" | "used";
          email_delivery_status?: "pending" | "sent" | "failed";
          email_provider_id?: string | null;
          email_sent_at?: string | null;
          email_last_error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          resident_id?: string;
          guest_name?: string;
          guest_email?: string;
          guest_phone?: string | null;
          guest_address?: string | null;
          share_token?: string;
          expires_at?: string;
          used_at?: string | null;
          status?: "active" | "revoked" | "used";
          email_delivery_status?: "pending" | "sent" | "failed";
          email_provider_id?: string | null;
          email_sent_at?: string | null;
          email_last_error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "guest_passes_resident_id_fkey";
            columns: ["resident_id"];
            isOneToOne: false;
            referencedRelation: "residents";
            referencedColumns: ["id"];
          },
        ];
      };
      entry_logs: {
        Row: {
          id: string;
          resident_id: string | null;
          guest_pass_id: string | null;
          entry_type: "resident" | "guest";
          tenant_name: string;
          unit_address: string;
          property_name: string;
          entered_at: string;
          scanner_id: string | null;
          notes: string | null;
        };
        Insert: {
          id?: string;
          resident_id?: string | null;
          guest_pass_id?: string | null;
          entry_type: "resident" | "guest";
          tenant_name: string;
          unit_address: string;
          property_name: string;
          entered_at?: string;
          scanner_id?: string | null;
          notes?: string | null;
        };
        Update: {
          id?: string;
          resident_id?: string | null;
          guest_pass_id?: string | null;
          entry_type?: "resident" | "guest";
          tenant_name?: string;
          unit_address?: string;
          property_name?: string;
          entered_at?: string;
          scanner_id?: string | null;
          notes?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "entry_logs_guest_pass_id_fkey";
            columns: ["guest_pass_id"];
            isOneToOne: false;
            referencedRelation: "guest_passes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entry_logs_resident_id_fkey";
            columns: ["resident_id"];
            isOneToOne: false;
            referencedRelation: "residents";
            referencedColumns: ["id"];
          },
        ];
      };
      entry_log_photos: {
        Row: {
          id: string;
          entry_log_id: string;
          resident_id: string | null;
          guest_pass_id: string | null;
          entry_type: "resident" | "guest";
          scanner_id: string | null;
          storage_path: string;
          content_type: string;
          byte_size: number;
          flagged_at: string | null;
          retention_expires_at: string;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          entry_log_id: string;
          resident_id?: string | null;
          guest_pass_id?: string | null;
          entry_type: "resident" | "guest";
          scanner_id?: string | null;
          storage_path: string;
          content_type: string;
          byte_size: number;
          flagged_at?: string | null;
          retention_expires_at?: string;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          entry_log_id?: string;
          resident_id?: string | null;
          guest_pass_id?: string | null;
          entry_type?: "resident" | "guest";
          scanner_id?: string | null;
          storage_path?: string;
          content_type?: string;
          byte_size?: number;
          flagged_at?: string | null;
          retention_expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "entry_log_photos_entry_log_id_fkey";
            columns: ["entry_log_id"];
            isOneToOne: false;
            referencedRelation: "entry_logs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entry_log_photos_guest_pass_id_fkey";
            columns: ["guest_pass_id"];
            isOneToOne: false;
            referencedRelation: "guest_passes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "entry_log_photos_resident_id_fkey";
            columns: ["resident_id"];
            isOneToOne: false;
            referencedRelation: "residents";
            referencedColumns: ["id"];
          },
        ];
      };
      guest_pass_bans: {
        Row: {
          id: string;
          resident_id: string;
          reason: string | null;
          banned_by: string;
          banned_at: string;
        };
        Insert: {
          id?: string;
          resident_id: string;
          reason?: string | null;
          banned_by: string;
          banned_at?: string;
        };
        Update: {
          id?: string;
          resident_id?: string;
          reason?: string | null;
          banned_by?: string;
          banned_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "guest_pass_bans_resident_id_fkey";
            columns: ["resident_id"];
            isOneToOne: false;
            referencedRelation: "residents";
            referencedColumns: ["id"];
          },
        ];
      };
      guest_pass_unit_bans: {
        Row: {
          resman_unit_id: string;
          unit_number: string;
          reason: string | null;
          banned_by: string;
          banned_at: string;
          expiry_kind: string;
          expires_at: string | null;
          bound_lease_id: string | null;
          status_trigger: string | null;
        };
        Insert: {
          resman_unit_id: string;
          unit_number: string;
          reason?: string | null;
          banned_by: string;
          banned_at?: string;
          expiry_kind?: string;
          expires_at?: string | null;
          bound_lease_id?: string | null;
          status_trigger?: string | null;
        };
        Update: {
          resman_unit_id?: string;
          unit_number?: string;
          reason?: string | null;
          banned_by?: string;
          banned_at?: string;
          expiry_kind?: string;
          expires_at?: string | null;
          bound_lease_id?: string | null;
          status_trigger?: string | null;
        };
        Relationships: [];
      };
      scanner_devices: {
        Row: {
          id: string;
          scanner_id: string;
          name: string;
          location: string | null;
          enabled: boolean;
          secret_hash: string | null;
          secret_rotated_at: string | null;
          last_seen_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          scanner_id: string;
          name: string;
          location?: string | null;
          enabled?: boolean;
          secret_hash?: string | null;
          secret_rotated_at?: string | null;
          last_seen_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          scanner_id?: string;
          name?: string;
          location?: string | null;
          enabled?: boolean;
          secret_hash?: string | null;
          secret_rotated_at?: string | null;
          last_seen_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      admin_users: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          role: "super_admin" | "property_manager" | "security_manager" | "viewer";
          resman_username: string | null;
          resman_person_id: string | null;
          last_login_at: string | null;
          active: boolean;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          email?: string | null;
          display_name?: string | null;
          role: "super_admin" | "property_manager" | "security_manager" | "viewer";
          resman_username?: string | null;
          resman_person_id?: string | null;
          last_login_at?: string | null;
          active?: boolean;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          email?: string | null;
          display_name?: string | null;
          role?: "super_admin" | "property_manager" | "security_manager" | "viewer";
          resman_username?: string | null;
          resman_person_id?: string | null;
          last_login_at?: string | null;
          active?: boolean;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      access_tokens: {
        Row: {
          id: string;
          token_hash: string;
          token_prefix: string;
          kind: "mcp" | "api_resman";
          subject_type: "admin_user" | "scanner";
          subject_id: string;
          label: string;
          role: string;
          scopes: string[];
          active: boolean;
          last_used_at: string | null;
          created_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          token_hash: string;
          token_prefix?: string;
          kind?: "mcp" | "api_resman";
          subject_type?: "admin_user" | "scanner";
          subject_id?: string;
          label?: string;
          role?: string;
          scopes?: string[];
          active?: boolean;
          last_used_at?: string | null;
          created_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          token_hash?: string;
          token_prefix?: string;
          kind?: "mcp" | "api_resman";
          subject_type?: "admin_user" | "scanner";
          subject_id?: string;
          label?: string;
          role?: string;
          scopes?: string[];
          active?: boolean;
          last_used_at?: string | null;
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      access_token_audit_log: {
        Row: {
          id: string;
          token_id: string | null;
          subject_type: string;
          subject_id: string;
          label: string;
          kind: string;
          tool: string;
          resource: string;
          arguments: Json | null;
          ok: boolean;
          error: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          token_id?: string | null;
          subject_type?: string;
          subject_id?: string;
          label?: string;
          kind?: string;
          tool?: string;
          resource?: string;
          arguments?: Json | null;
          ok?: boolean;
          error?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          token_id?: string | null;
          subject_type?: string;
          subject_id?: string;
          label?: string;
          kind?: string;
          tool?: string;
          resource?: string;
          arguments?: Json | null;
          ok?: boolean;
          error?: string;
        };
        Relationships: [
          {
            foreignKeyName: "access_token_audit_log_token_id_fkey";
            columns: ["token_id"];
            referencedRelation: "access_tokens";
            referencedColumns: ["id"];
          },
        ];
      };
      admin_audit_logs: {
        Row: {
          id: string;
          admin_user_id: string;
          admin_role: string;
          admin_display_name: string | null;
          action: string;
          target_type: string;
          target_id: string;
          metadata: Json;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          admin_user_id: string;
          admin_role: string;
          admin_display_name?: string | null;
          action: string;
          target_type: string;
          target_id: string;
          metadata?: Json;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          admin_user_id?: string;
          admin_role?: string;
          admin_display_name?: string | null;
          action?: string;
          target_type?: string;
          target_id?: string;
          metadata?: Json;
        };
        Relationships: [];
      };
      rate_limits: {
        Row: {
          bucket: string;
          window_start: string;
          count: number;
          expires_at: string;
          updated_at: string | null;
        };
        Insert: {
          bucket: string;
          window_start: string;
          count?: number;
          expires_at: string;
          updated_at?: string | null;
        };
        Update: {
          bucket?: string;
          window_start?: string;
          count?: number;
          expires_at?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      resident_devices: {
        Row: {
          id: string;
          resident_id: string;
          token_hash: string;
          user_agent: string | null;
          active: boolean;
          expires_at: string;
          last_seen_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          resident_id: string;
          token_hash: string;
          user_agent?: string | null;
          active?: boolean;
          expires_at: string;
          last_seen_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          resident_id?: string;
          token_hash?: string;
          user_agent?: string | null;
          active?: boolean;
          expires_at?: string;
          last_seen_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resident_devices_resident_id_fkey";
            columns: ["resident_id"];
            isOneToOne: false;
            referencedRelation: "residents";
            referencedColumns: ["id"];
          },
        ];
      };
      map_cameras: {
        Row: {
          id: string;
          normalized_x: number;
          normalized_y: number;
          direction: number;
          fov: number;
          range: number;
          active: boolean;
          unifi_console_id: string | null;
          unifi_camera_id: string | null;
          unifi_camera_name: string | null;
          unifi_camera_name_synced_at: string | null;
          created_by_display_name: string | null;
          updated_by_display_name: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          normalized_x: number;
          normalized_y: number;
          direction?: number;
          fov?: number;
          range?: number;
          active?: boolean;
          unifi_console_id?: string | null;
          unifi_camera_id?: string | null;
          unifi_camera_name?: string | null;
          unifi_camera_name_synced_at?: string | null;
          created_by_display_name?: string | null;
          updated_by_display_name?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          normalized_x?: number;
          normalized_y?: number;
          direction?: number;
          fov?: number;
          range?: number;
          active?: boolean;
          unifi_console_id?: string | null;
          unifi_camera_id?: string | null;
          unifi_camera_name?: string | null;
          unifi_camera_name_synced_at?: string | null;
          created_by_display_name?: string | null;
          updated_by_display_name?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      unit_tags: {
        Row: {
          id: string;
          unit_number: string;
          label: string;
          color_hex: string;
          expiry_kind: string;
          expires_at: string | null;
          bound_lease_id: string | null;
          status_trigger: string | null;
          origin: string;
          created_by_display_name: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          unit_number: string;
          label: string;
          color_hex?: string;
          expiry_kind?: string;
          expires_at?: string | null;
          bound_lease_id?: string | null;
          status_trigger?: string | null;
          origin?: string;
          created_by_display_name?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          unit_number?: string;
          label?: string;
          color_hex?: string;
          expiry_kind?: string;
          expires_at?: string | null;
          bound_lease_id?: string | null;
          status_trigger?: string | null;
          origin?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      map_annotations: {
        Row: {
          id: string;
          resman_account_id: string;
          property_id: string;
          feature_key: string;
          title: string;
          notes: string;
          normalized_x: number;
          normalized_y: number;
          color_hex: string;
          layer: string;
          origin: string;
          icon: string;
          kind: string;
          utility_type: string | null;
          points: Json | null;
          line_style: string | null;
          line_weight: string | null;
          flow_arrows: boolean | null;
          created_by_display_name: string | null;
          created_at: string | null;
          updated_by_display_name: string | null;
          updated_at: string | null;
          deleted_by_display_name: string | null;
          deleted_at: string | null;
          version: number;
        };
        Insert: {
          id?: string;
          resman_account_id: string;
          property_id: string;
          feature_key?: string;
          title: string;
          notes?: string;
          normalized_x: number;
          normalized_y: number;
          color_hex: string;
          layer?: string;
          origin?: string;
          icon?: string;
          kind?: string;
          utility_type?: string | null;
          points?: Json | null;
          line_style?: string | null;
          line_weight?: string | null;
          flow_arrows?: boolean | null;
          created_by_display_name?: string | null;
          created_at?: string | null;
          updated_by_display_name?: string | null;
          updated_at?: string | null;
          deleted_by_display_name?: string | null;
          deleted_at?: string | null;
          version?: number;
        };
        Update: {
          id?: string;
          resman_account_id?: string;
          property_id?: string;
          feature_key?: string;
          title?: string;
          notes?: string;
          normalized_x?: number;
          normalized_y?: number;
          color_hex?: string;
          layer?: string;
          origin?: string;
          icon?: string;
          kind?: string;
          utility_type?: string | null;
          points?: Json | null;
          line_style?: string | null;
          line_weight?: string | null;
          flow_arrows?: boolean | null;
          created_by_display_name?: string | null;
          updated_by_display_name?: string | null;
          updated_at?: string | null;
          deleted_by_display_name?: string | null;
          deleted_at?: string | null;
          version?: number;
        };
        Relationships: [
        ];
      };
      map_annotation_photos: {
        Row: {
          id: string;
          annotation_id: string;
          resman_account_id: string;
          property_id: string;
          feature_key: string;
          storage_path: string;
          content_type: string;
          byte_size: number;
          created_by: string;
          created_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          annotation_id: string;
          resman_account_id: string;
          property_id: string;
          feature_key?: string;
          storage_path: string;
          content_type: string;
          byte_size: number;
          created_by?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          annotation_id?: string;
          resman_account_id?: string;
          property_id?: string;
          feature_key?: string;
          storage_path?: string;
          content_type?: string;
          byte_size?: number;
          created_by?: string;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "map_annotation_photos_annotation_scope_fkey";
            columns: ["annotation_id", "resman_account_id", "property_id", "feature_key"];
            isOneToOne: false;
            referencedRelation: "map_annotations";
            referencedColumns: ["id", "resman_account_id", "property_id", "feature_key"];
          },
        ];
      };
      map_annotation_audit_logs: {
        Row: {
          id: string;
          resman_account_id: string;
          property_id: string;
          feature_key: string;
          action:
            | "access.request"
            | "access.approve"
            | "access.reject"
            | "access.claim"
            | "access.revoke"
            | "annotation.create"
            | "annotation.update"
            | "annotation.delete";
          annotation_id: string | null;
          actor_display_name: string | null;
          admin_user_id: string | null;
          admin_display_name: string | null;
          metadata: Json;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          resman_account_id: string;
          property_id: string;
          feature_key: string;
          action:
            | "access.request"
            | "access.approve"
            | "access.reject"
            | "access.claim"
            | "access.revoke"
            | "annotation.create"
            | "annotation.update"
            | "annotation.delete";
          annotation_id?: string | null;
          actor_display_name?: string | null;
          admin_user_id?: string | null;
          admin_display_name?: string | null;
          metadata?: Json;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          resman_account_id?: string;
          property_id?: string;
          feature_key?: string;
          action?:
            | "access.request"
            | "access.approve"
            | "access.reject"
            | "access.claim"
            | "access.revoke"
            | "annotation.create"
            | "annotation.update"
            | "annotation.delete";
          annotation_id?: string | null;
          actor_display_name?: string | null;
          admin_user_id?: string | null;
          admin_display_name?: string | null;
          metadata?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "map_annotation_audit_logs_annotation_scope_fkey";
            columns: ["annotation_id", "resman_account_id", "property_id", "feature_key"];
            isOneToOne: false;
            referencedRelation: "map_annotations";
            referencedColumns: ["id", "resman_account_id", "property_id", "feature_key"];
          },
        ];
      };
      resman_properties: {
        Row: {
          resman_property_id: string;
          resman_account_id: string;
          name: string;
          custom_name: string;
          abbreviation: string;
          phone: string;
          email: string;
          website: string;
          logo_url: string;
          management_company: string;
          property_type: string;
          time_zone: string;
          regional_manager: string;
          property_manager: string;
          leasing_agent: string;
          resident_portal_url: string;
          address: string;
          city: string;
          state: string;
          postal_code: string;
          unit_count: number;
          last_sync_date: string | null;
          synced_at: string | null;
          raw: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_property_id: string;
          resman_account_id?: string;
          name?: string;
          custom_name?: string;
          abbreviation?: string;
          phone?: string;
          email?: string;
          website?: string;
          logo_url?: string;
          management_company?: string;
          property_type?: string;
          time_zone?: string;
          regional_manager?: string;
          property_manager?: string;
          leasing_agent?: string;
          resident_portal_url?: string;
          address?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          unit_count?: number;
          last_sync_date?: string | null;
          synced_at?: string | null;
          raw?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_property_id?: string;
          resman_account_id?: string;
          name?: string;
          custom_name?: string;
          abbreviation?: string;
          phone?: string;
          email?: string;
          website?: string;
          logo_url?: string;
          management_company?: string;
          property_type?: string;
          time_zone?: string;
          regional_manager?: string;
          property_manager?: string;
          leasing_agent?: string;
          resident_portal_url?: string;
          address?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          unit_count?: number;
          last_sync_date?: string | null;
          synced_at?: string | null;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      resman_buildings: {
        Row: {
          resman_building_id: string;
          resman_property_id: string;
          name: string;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_building_id: string;
          resman_property_id: string;
          name?: string;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_building_id?: string;
          resman_property_id?: string;
          name?: string;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_buildings_resman_property_id_fkey";
            columns: ["resman_property_id"];
            isOneToOne: false;
            referencedRelation: "resman_properties";
            referencedColumns: ["resman_property_id"];
          },
        ];
      };
      resman_floorplans: {
        Row: {
          resman_floorplan_id: string;
          resman_property_id: string | null;
          name: string;
          description: string;
          square_feet: number | null;
          market_rent: number | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_floorplan_id: string;
          resman_property_id?: string | null;
          name?: string;
          description?: string;
          square_feet?: number | null;
          market_rent?: number | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_floorplan_id?: string;
          resman_property_id?: string | null;
          name?: string;
          description?: string;
          square_feet?: number | null;
          market_rent?: number | null;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_floorplans_resman_property_id_fkey";
            columns: ["resman_property_id"];
            isOneToOne: false;
            referencedRelation: "resman_properties";
            referencedColumns: ["resman_property_id"];
          },
        ];
      };
      resman_units: {
        Row: {
          resman_unit_id: string;
          resman_property_id: string;
          resman_building_id: string | null;
          resman_floorplan_id: string | null;
          number: string;
          current_lease_id: string | null;
          pending_lease_id: string | null;
          availability: string;
          lease_status:
            | "Current"
            | "Under Eviction"
            | "Notice to Vacate"
            | "Month to Month"
            | "Pending"
            | "Pending Renewal"
            | "Cancelled"
            | null;
          occupancy_status: "Occupied" | "Vacant" | "Notice" | null;
          classification: string;
          notes: string;
          occupied: boolean | null;
          market_rent: number | null;
          lease_rent: number | null;
          deposit_required: number | null;
          deposit_held: number | null;
          balance: number | null;
          bedrooms: number | null;
          bathrooms: number | null;
          pets_permitted: boolean | null;
          affordable_unit: boolean | null;
          holding_unit: boolean | null;
          excluded_from_occupancy: boolean | null;
          available_for_online_marketing: boolean | null;
          street: string;
          city: string;
          state: string;
          postal_code: string;
          country: string;
          lease_start_date: string | null;
          lease_end_date: string | null;
          move_in_date: string | null;
          move_out_date: string | null;
          lease_term: string | null;
          old_lease_id: string | null;
          date_available: string | null;
          leasing_agent: string | null;
          floor: string | null;
          hearing_accessible: boolean | null;
          mobility_accessible: boolean | null;
          visual_accessible: boolean | null;
          pending_move_in_date: string | null;
          pending_lease_start_date: string | null;
          pending_lease_end_date: string | null;
          max_occupancy: number | null;
          current_month_balance: number | null;
          last_month_balance: number | null;
          period_balance: number | null;
          previous_balance: number | null;
          times_late: number | null;
          delinquency_reason: string | null;
          tenant_names: string[];
          source_url: string;
          scraped_at: string | null;
          synced_at: string | null;
          raw: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_unit_id: string;
          resman_property_id: string;
          resman_building_id?: string | null;
          resman_floorplan_id?: string | null;
          number?: string;
          current_lease_id?: string | null;
          pending_lease_id?: string | null;
          availability?: string;
          lease_status?:
            | "Current"
            | "Under Eviction"
            | "Notice to Vacate"
            | "Month to Month"
            | "Pending"
            | "Pending Renewal"
            | "Cancelled"
            | null;
          occupancy_status?: "Occupied" | "Vacant" | "Notice" | null;
          classification?: string;
          notes?: string;
          occupied?: boolean | null;
          market_rent?: number | null;
          lease_rent?: number | null;
          deposit_required?: number | null;
          deposit_held?: number | null;
          balance?: number | null;
          bedrooms?: number | null;
          bathrooms?: number | null;
          pets_permitted?: boolean | null;
          affordable_unit?: boolean | null;
          holding_unit?: boolean | null;
          excluded_from_occupancy?: boolean | null;
          available_for_online_marketing?: boolean | null;
          street?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          country?: string;
          lease_start_date?: string | null;
          lease_end_date?: string | null;
          move_in_date?: string | null;
          move_out_date?: string | null;
          lease_term?: string | null;
          old_lease_id?: string | null;
          date_available?: string | null;
          leasing_agent?: string | null;
          floor?: string | null;
          hearing_accessible?: boolean | null;
          mobility_accessible?: boolean | null;
          visual_accessible?: boolean | null;
          pending_move_in_date?: string | null;
          pending_lease_start_date?: string | null;
          pending_lease_end_date?: string | null;
          max_occupancy?: number | null;
          current_month_balance?: number | null;
          last_month_balance?: number | null;
          period_balance?: number | null;
          previous_balance?: number | null;
          times_late?: number | null;
          delinquency_reason?: string | null;
          tenant_names?: string[];
          source_url?: string;
          scraped_at?: string | null;
          synced_at?: string | null;
          raw?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_unit_id?: string;
          resman_property_id?: string;
          resman_building_id?: string | null;
          resman_floorplan_id?: string | null;
          number?: string;
          current_lease_id?: string | null;
          pending_lease_id?: string | null;
          availability?: string;
          lease_status?:
            | "Current"
            | "Under Eviction"
            | "Notice to Vacate"
            | "Month to Month"
            | "Pending"
            | "Pending Renewal"
            | "Cancelled"
            | null;
          occupancy_status?: "Occupied" | "Vacant" | "Notice" | null;
          classification?: string;
          notes?: string;
          occupied?: boolean | null;
          market_rent?: number | null;
          lease_rent?: number | null;
          deposit_required?: number | null;
          deposit_held?: number | null;
          balance?: number | null;
          bedrooms?: number | null;
          bathrooms?: number | null;
          pets_permitted?: boolean | null;
          affordable_unit?: boolean | null;
          holding_unit?: boolean | null;
          excluded_from_occupancy?: boolean | null;
          available_for_online_marketing?: boolean | null;
          street?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          country?: string;
          lease_start_date?: string | null;
          lease_end_date?: string | null;
          move_in_date?: string | null;
          move_out_date?: string | null;
          lease_term?: string | null;
          old_lease_id?: string | null;
          date_available?: string | null;
          leasing_agent?: string | null;
          floor?: string | null;
          hearing_accessible?: boolean | null;
          mobility_accessible?: boolean | null;
          visual_accessible?: boolean | null;
          pending_move_in_date?: string | null;
          pending_lease_start_date?: string | null;
          pending_lease_end_date?: string | null;
          max_occupancy?: number | null;
          current_month_balance?: number | null;
          last_month_balance?: number | null;
          period_balance?: number | null;
          previous_balance?: number | null;
          times_late?: number | null;
          delinquency_reason?: string | null;
          tenant_names?: string[];
          source_url?: string;
          scraped_at?: string | null;
          synced_at?: string | null;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_units_resman_property_id_fkey";
            columns: ["resman_property_id"];
            isOneToOne: false;
            referencedRelation: "resman_properties";
            referencedColumns: ["resman_property_id"];
          },
          {
            foreignKeyName: "resman_units_resman_building_id_fkey";
            columns: ["resman_building_id"];
            isOneToOne: false;
            referencedRelation: "resman_buildings";
            referencedColumns: ["resman_building_id"];
          },
          {
            foreignKeyName: "resman_units_resman_floorplan_id_fkey";
            columns: ["resman_floorplan_id"];
            isOneToOne: false;
            referencedRelation: "resman_floorplans";
            referencedColumns: ["resman_floorplan_id"];
          },
        ];
      };
      resman_leases: {
        Row: {
          resman_lease_id: string;
          unit_lease_group_id: string;
          resman_property_id: string | null;
          resman_unit_id: string | null;
          unit_number: string;
          status: string;
          approval_status: string;
          approved_date: string | null;
          approved_by: string;
          original_start_date: string | null;
          start_date_changes: number;
          lease_sent_date: string | null;
          lease_voided_date: string | null;
          deposit_amount: number | null;
          deposit_logged_date: string | null;
          application_date: string | null;
          signed_date: string | null;
          start_date: string | null;
          end_date: string | null;
          move_in_date: string | null;
          move_out_date: string | null;
          leasing_agent: string;
          renewal_date: string | null;
          notice_given_date: string | null;
          market_rent: number | null;
          resident_rent: number | null;
          hap_rent: number | null;
          monthly_charge: number | null;
          balance: number | null;
          collection_balance: number | null;
          reason_for_leaving: string;
          is_current_lease: boolean;
          is_most_recent_lease: boolean;
          synced_at: string | null;
          deep_synced_at: string | null;
          raw: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_lease_id: string;
          unit_lease_group_id?: string;
          resman_property_id?: string | null;
          resman_unit_id?: string | null;
          unit_number?: string;
          status?: string;
          approval_status?: string;
          approved_date?: string | null;
          approved_by?: string;
          original_start_date?: string | null;
          start_date_changes?: number;
          lease_sent_date?: string | null;
          lease_voided_date?: string | null;
          deposit_amount?: number | null;
          deposit_logged_date?: string | null;
          application_date?: string | null;
          signed_date?: string | null;
          start_date?: string | null;
          end_date?: string | null;
          move_in_date?: string | null;
          move_out_date?: string | null;
          leasing_agent?: string;
          renewal_date?: string | null;
          notice_given_date?: string | null;
          market_rent?: number | null;
          resident_rent?: number | null;
          hap_rent?: number | null;
          monthly_charge?: number | null;
          balance?: number | null;
          collection_balance?: number | null;
          reason_for_leaving?: string;
          is_current_lease?: boolean;
          is_most_recent_lease?: boolean;
          synced_at?: string | null;
          deep_synced_at?: string | null;
          raw?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_lease_id?: string;
          unit_lease_group_id?: string;
          resman_property_id?: string | null;
          resman_unit_id?: string | null;
          unit_number?: string;
          status?: string;
          approval_status?: string;
          approved_date?: string | null;
          approved_by?: string;
          original_start_date?: string | null;
          start_date_changes?: number;
          lease_sent_date?: string | null;
          lease_voided_date?: string | null;
          deposit_amount?: number | null;
          deposit_logged_date?: string | null;
          application_date?: string | null;
          signed_date?: string | null;
          start_date?: string | null;
          end_date?: string | null;
          move_in_date?: string | null;
          move_out_date?: string | null;
          leasing_agent?: string;
          renewal_date?: string | null;
          notice_given_date?: string | null;
          market_rent?: number | null;
          resident_rent?: number | null;
          hap_rent?: number | null;
          monthly_charge?: number | null;
          balance?: number | null;
          collection_balance?: number | null;
          reason_for_leaving?: string;
          is_current_lease?: boolean;
          is_most_recent_lease?: boolean;
          synced_at?: string | null;
          deep_synced_at?: string | null;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_leases_resman_property_id_fkey";
            columns: ["resman_property_id"];
            isOneToOne: false;
            referencedRelation: "resman_properties";
            referencedColumns: ["resman_property_id"];
          },
          {
            foreignKeyName: "resman_leases_resman_unit_id_fkey";
            columns: ["resman_unit_id"];
            isOneToOne: false;
            referencedRelation: "resman_units";
            referencedColumns: ["resman_unit_id"];
          },
        ];
      };
      resman_residents: {
        Row: {
          resman_person_lease_id: string;
          resman_person_id: string;
          resman_lease_id: string;
          first_name: string;
          last_name: string;
          email: string;
          phone_numbers: string[];
          gender: string;
          birthdate: string | null;
          household_status: string;
          drivers_license: string;
          drivers_license_state: string;
          language: string;
          identification: string;
          is_primary: boolean;
          synced_at: string | null;
          raw: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_person_lease_id: string;
          resman_person_id?: string;
          resman_lease_id: string;
          first_name?: string;
          last_name?: string;
          email?: string;
          phone_numbers?: string[];
          gender?: string;
          birthdate?: string | null;
          household_status?: string;
          drivers_license?: string;
          drivers_license_state?: string;
          language?: string;
          identification?: string;
          is_primary?: boolean;
          synced_at?: string | null;
          raw?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_person_lease_id?: string;
          resman_person_id?: string;
          resman_lease_id?: string;
          first_name?: string;
          last_name?: string;
          email?: string;
          phone_numbers?: string[];
          gender?: string;
          birthdate?: string | null;
          household_status?: string;
          drivers_license?: string;
          drivers_license_state?: string;
          language?: string;
          identification?: string;
          is_primary?: boolean;
          synced_at?: string | null;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_residents_resman_lease_id_fkey";
            columns: ["resman_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_leases";
            referencedColumns: ["resman_lease_id"];
          },
        ];
      };
      resman_lease_vehicles: {
        Row: {
          resman_vehicle_id: string;
          resman_person_lease_id: string;
          make: string;
          model: string;
          year: string;
          color: string;
          license_plate: string;
          license_plate_state: string;
          parking_spot: string;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_vehicle_id: string;
          resman_person_lease_id: string;
          make?: string;
          model?: string;
          year?: string;
          color?: string;
          license_plate?: string;
          license_plate_state?: string;
          parking_spot?: string;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_vehicle_id?: string;
          resman_person_lease_id?: string;
          make?: string;
          model?: string;
          year?: string;
          color?: string;
          license_plate?: string;
          license_plate_state?: string;
          parking_spot?: string;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_lease_vehicles_resman_person_lease_id_fkey";
            columns: ["resman_person_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_residents";
            referencedColumns: ["resman_person_lease_id"];
          },
        ];
      };
      resman_lease_employment: {
        Row: {
          resman_employment_id: string;
          resman_person_lease_id: string;
          employer_name: string;
          position: string;
          phone: string;
          other_income_source: string;
          monthly_income: number | null;
          other_income: number | null;
          start_date: string | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_employment_id: string;
          resman_person_lease_id: string;
          employer_name?: string;
          position?: string;
          phone?: string;
          other_income_source?: string;
          monthly_income?: number | null;
          other_income?: number | null;
          start_date?: string | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_employment_id?: string;
          resman_person_lease_id?: string;
          employer_name?: string;
          position?: string;
          phone?: string;
          other_income_source?: string;
          monthly_income?: number | null;
          other_income?: number | null;
          start_date?: string | null;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_lease_employment_resman_person_lease_id_fkey";
            columns: ["resman_person_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_residents";
            referencedColumns: ["resman_person_lease_id"];
          },
        ];
      };
      resman_lease_insurance: {
        Row: {
          resman_insurance_id: string;
          resman_person_lease_id: string;
          provider: string;
          policy_number: string;
          policy_type: string;
          status: string;
          start_date: string | null;
          end_date: string | null;
          coverage_amount: number | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_insurance_id: string;
          resman_person_lease_id: string;
          provider?: string;
          policy_number?: string;
          policy_type?: string;
          status?: string;
          start_date?: string | null;
          end_date?: string | null;
          coverage_amount?: number | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_insurance_id?: string;
          resman_person_lease_id?: string;
          provider?: string;
          policy_number?: string;
          policy_type?: string;
          status?: string;
          start_date?: string | null;
          end_date?: string | null;
          coverage_amount?: number | null;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_lease_insurance_resman_person_lease_id_fkey";
            columns: ["resman_person_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_residents";
            referencedColumns: ["resman_person_lease_id"];
          },
        ];
      };
      resman_lease_addresses: {
        Row: {
          resman_address_id: string;
          resman_person_lease_id: string;
          address_type: string;
          street: string;
          city: string;
          state: string;
          postal_code: string;
          country: string;
          start_date: string | null;
          end_date: string | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_address_id: string;
          resman_person_lease_id: string;
          address_type?: string;
          street?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          country?: string;
          start_date?: string | null;
          end_date?: string | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_address_id?: string;
          resman_person_lease_id?: string;
          address_type?: string;
          street?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          country?: string;
          start_date?: string | null;
          end_date?: string | null;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_lease_addresses_resman_person_lease_id_fkey";
            columns: ["resman_person_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_residents";
            referencedColumns: ["resman_person_lease_id"];
          },
        ];
      };
      resman_lease_alternate_contacts: {
        Row: {
          resman_contact_id: string;
          resman_person_lease_id: string;
          name: string;
          relationship: string;
          phone: string;
          email: string;
          is_emergency_contact: boolean;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_contact_id: string;
          resman_person_lease_id: string;
          name?: string;
          relationship?: string;
          phone?: string;
          email?: string;
          is_emergency_contact?: boolean;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_contact_id?: string;
          resman_person_lease_id?: string;
          name?: string;
          relationship?: string;
          phone?: string;
          email?: string;
          is_emergency_contact?: boolean;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_lease_alternate_contacts_resman_person_lease_id_fkey";
            columns: ["resman_person_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_residents";
            referencedColumns: ["resman_person_lease_id"];
          },
        ];
      };
      resman_transactions: {
        Row: {
          resman_ledger_entry_id: string;
          resman_property_id: string;
          resman_unit_id: string;
          resman_lease_id: string | null;
          transaction_id: string;
          transaction_type: string;
          date: string | null;
          reference: string;
          batch: string;
          batch_id: string;
          category: string;
          ledger_description: string;
          notes: string;
          charges: number | null;
          credits: number | null;
          balance: number | null;
          ledger_sequence: number | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_ledger_entry_id: string;
          resman_property_id?: string;
          resman_unit_id?: string;
          resman_lease_id?: string | null;
          transaction_id?: string;
          transaction_type?: string;
          date?: string | null;
          reference?: string;
          batch?: string;
          batch_id?: string;
          category?: string;
          ledger_description?: string;
          notes?: string;
          charges?: number | null;
          credits?: number | null;
          balance?: number | null;
          ledger_sequence?: number | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_ledger_entry_id?: string;
          resman_property_id?: string;
          resman_unit_id?: string;
          resman_lease_id?: string | null;
          transaction_id?: string;
          transaction_type?: string;
          date?: string | null;
          reference?: string;
          batch?: string;
          batch_id?: string;
          category?: string;
          ledger_description?: string;
          notes?: string;
          charges?: number | null;
          credits?: number | null;
          balance?: number | null;
          ledger_sequence?: number | null;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_transactions_resman_lease_id_fkey";
            columns: ["resman_lease_id"];
            isOneToOne: false;
            referencedRelation: "resman_leases";
            referencedColumns: ["resman_lease_id"];
          },
        ];
      };
      resman_work_orders: {
        Row: {
          resman_work_order_id: string;
          number: string;
          resman_unit_id: string | null;
          unit_lease_group_id: string;
          resman_lease_id: string;
          unit_number: string;
          resman_property_id: string | null;
          status:
            | "Not Started"
            | "Scheduled"
            | "In Progress"
            | "Completed"
            | "Closed"
            | "Canceled";
          priority: "Emergency" | "High" | "Normal" | "Low";
          category: string;
          title: string;
          notes: string;
          completion_notes: string;
          technician: string;
          date_reported: string | null;
          date_scheduled: string | null;
          date_completed: string | null;
          is_make_ready: boolean;
          callback_requested: boolean;
          callback_completed: boolean;
          tags: string[];
          is_duplicate: boolean;
          callback_status: "none" | "possible" | "confirmed" | "dismissed";
          callback_matched_work_order_id: string;
          callback_engine_version: string;
          callback_source: string;
          callback_detected_at: string | null;
          synced_at: string | null;
          raw: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          resman_work_order_id: string;
          number?: string;
          resman_unit_id?: string | null;
          unit_lease_group_id?: string;
          resman_lease_id?: string;
          unit_number?: string;
          resman_property_id?: string | null;
          status?:
            | "Not Started"
            | "Scheduled"
            | "In Progress"
            | "Completed"
            | "Closed"
            | "Canceled";
          priority?: "Emergency" | "High" | "Normal" | "Low";
          category?: string;
          title?: string;
          notes?: string;
          completion_notes?: string;
          technician?: string;
          date_reported?: string | null;
          date_scheduled?: string | null;
          date_completed?: string | null;
          is_make_ready?: boolean;
          callback_requested?: boolean;
          callback_completed?: boolean;
          tags?: string[];
          is_duplicate?: boolean;
          callback_status?: "none" | "possible" | "confirmed" | "dismissed";
          callback_matched_work_order_id?: string;
          callback_engine_version?: string;
          callback_source?: string;
          callback_detected_at?: string | null;
          synced_at?: string | null;
          raw?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          resman_work_order_id?: string;
          number?: string;
          resman_unit_id?: string | null;
          unit_lease_group_id?: string;
          resman_lease_id?: string;
          unit_number?: string;
          resman_property_id?: string | null;
          status?:
            | "Not Started"
            | "Scheduled"
            | "In Progress"
            | "Completed"
            | "Closed"
            | "Canceled";
          priority?: "Emergency" | "High" | "Normal" | "Low";
          category?: string;
          title?: string;
          notes?: string;
          completion_notes?: string;
          technician?: string;
          date_reported?: string | null;
          date_scheduled?: string | null;
          date_completed?: string | null;
          is_make_ready?: boolean;
          callback_requested?: boolean;
          callback_completed?: boolean;
          tags?: string[];
          is_duplicate?: boolean;
          callback_status?: "none" | "possible" | "confirmed" | "dismissed";
          callback_matched_work_order_id?: string;
          callback_engine_version?: string;
          callback_source?: string;
          callback_detected_at?: string | null;
          synced_at?: string | null;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_work_orders_resman_unit_id_fkey";
            columns: ["resman_unit_id"];
            isOneToOne: false;
            referencedRelation: "resman_units";
            referencedColumns: ["resman_unit_id"];
          },
          {
            foreignKeyName: "resman_work_orders_resman_property_id_fkey";
            columns: ["resman_property_id"];
            isOneToOne: false;
            referencedRelation: "resman_properties";
            referencedColumns: ["resman_property_id"];
          },
        ];
      };
      work_order_photos: {
        Row: {
          id: string;
          resman_work_order_id: string;
          phase: "before" | "after" | "completion";
          storage_path: string;
          content_type: string;
          byte_size: number;
          created_by: string;
          created_by_admin_id: string;
          created_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          resman_work_order_id: string;
          phase?: "before" | "after" | "completion";
          storage_path: string;
          content_type: string;
          byte_size: number;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          resman_work_order_id?: string;
          phase?: "before" | "after" | "completion";
          storage_path?: string;
          content_type?: string;
          byte_size?: number;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "work_order_photos_resman_work_order_id_fkey";
            columns: ["resman_work_order_id"];
            isOneToOne: false;
            referencedRelation: "resman_work_orders";
            referencedColumns: ["resman_work_order_id"];
          },
        ];
      };
      pm_templates: {
        Row: {
          id: string;
          name: string;
          category: string;
          cadence: "monthly" | "quarterly" | "semiannual" | "annual";
          anchor_month: number | null;
          scope_type: "all" | "building" | "classification";
          scope_values: string[];
          active: boolean;
          created_by: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          category?: string;
          cadence: "monthly" | "quarterly" | "semiannual" | "annual";
          anchor_month?: number | null;
          scope_type?: "all" | "building" | "classification";
          scope_values?: string[];
          active?: boolean;
          created_by?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          category?: string;
          cadence?: "monthly" | "quarterly" | "semiannual" | "annual";
          anchor_month?: number | null;
          scope_type?: "all" | "building" | "classification";
          scope_values?: string[];
          active?: boolean;
          created_by?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      pm_tasks: {
        Row: {
          id: string;
          template_id: string;
          round_key: string;
          unit_number: string;
          due_date: string;
          status: "pending" | "done" | "skipped";
          completed_by: string;
          completed_at: string | null;
          resman_work_order_id: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          template_id: string;
          round_key: string;
          unit_number: string;
          due_date: string;
          status?: "pending" | "done" | "skipped";
          completed_by?: string;
          completed_at?: string | null;
          resman_work_order_id?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          template_id?: string;
          round_key?: string;
          unit_number?: string;
          due_date?: string;
          status?: "pending" | "done" | "skipped";
          completed_by?: string;
          completed_at?: string | null;
          resman_work_order_id?: string | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "pm_tasks_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "pm_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      delinquency_actions: {
        Row: {
          id: string;
          resman_lease_id: string;
          resman_unit_id: string;
          unit_number: string;
          kind:
            | "note"
            | "called"
            | "notice_served"
            | "promise_recorded"
            | "promise_kept"
            | "promise_broken"
            | "fed_filed"
            | "eviction_completed"
            | "writeoff"
            | "payment_plan";
          note: string;
          amount: number | null;
          promise_due_date: string | null;
          created_by: string;
          created_by_admin_id: string;
          created_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          resman_lease_id: string;
          resman_unit_id?: string;
          unit_number?: string;
          kind:
            | "note"
            | "called"
            | "notice_served"
            | "promise_recorded"
            | "promise_kept"
            | "promise_broken"
            | "fed_filed"
            | "eviction_completed"
            | "writeoff"
            | "payment_plan";
          note?: string;
          amount?: number | null;
          promise_due_date?: string | null;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          resman_lease_id?: string;
          resman_unit_id?: string;
          unit_number?: string;
          kind?:
            | "note"
            | "called"
            | "notice_served"
            | "promise_recorded"
            | "promise_kept"
            | "promise_broken"
            | "fed_filed"
            | "eviction_completed"
            | "writeoff"
            | "payment_plan";
          note?: string;
          amount?: number | null;
          promise_due_date?: string | null;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      insurance_actions: {
        Row: {
          id: string;
          resman_lease_id: string;
          unit_number: string;
          kind: "proof_requested" | "second_notice" | "verified" | "note";
          note: string;
          created_by: string;
          created_by_admin_id: string;
          created_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          resman_lease_id: string;
          unit_number?: string;
          kind: "proof_requested" | "second_notice" | "verified" | "note";
          note?: string;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          resman_lease_id?: string;
          unit_number?: string;
          kind?: "proof_requested" | "second_notice" | "verified" | "note";
          note?: string;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      renewal_offers: {
        Row: {
          id: string;
          resman_lease_id: string;
          resman_unit_id: string;
          unit_number: string;
          prior_rent: number | null;
          proposed_rent: number;
          term_months: number | null;
          is_month_to_month: boolean;
          status: "sent" | "accepted" | "declined" | "withdrawn";
          sent_at: string | null;
          responded_at: string | null;
          note: string;
          created_by: string;
          created_by_admin_id: string;
          created_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          resman_lease_id: string;
          resman_unit_id?: string;
          unit_number?: string;
          prior_rent?: number | null;
          proposed_rent: number;
          term_months?: number | null;
          is_month_to_month?: boolean;
          status?: "sent" | "accepted" | "declined" | "withdrawn";
          sent_at?: string | null;
          responded_at?: string | null;
          note?: string;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          resman_lease_id?: string;
          resman_unit_id?: string;
          unit_number?: string;
          prior_rent?: number | null;
          proposed_rent?: number;
          term_months?: number | null;
          is_month_to_month?: boolean;
          status?: "sent" | "accepted" | "declined" | "withdrawn";
          sent_at?: string | null;
          responded_at?: string | null;
          note?: string;
          created_by?: string;
          created_by_admin_id?: string;
          created_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      manager_alert_notifications: {
        Row: {
          id: string;
          kind:
            | "application_received"
            | "lease_signed"
            | "balance_threshold"
            | "eviction_milestone"
            | "utility_spike";
          subject_key: string;
          unit_number: string;
          title: string;
          body: string;
          amount: number | null;
          devices: number;
          notified_at: string;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          kind:
            | "application_received"
            | "lease_signed"
            | "balance_threshold"
            | "eviction_milestone"
            | "utility_spike";
          subject_key: string;
          unit_number?: string;
          title?: string;
          body?: string;
          amount?: number | null;
          devices?: number;
          notified_at?: string;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          kind?:
            | "application_received"
            | "lease_signed"
            | "balance_threshold"
            | "eviction_milestone"
            | "utility_spike";
          subject_key?: string;
          unit_number?: string;
          title?: string;
          body?: string;
          amount?: number | null;
          devices?: number;
          notified_at?: string;
          created_at?: string | null;
        };
        Relationships: [];
      };
      monitor_findings: {
        Row: {
          id: string;
          fingerprint: string;
          kind: string;
          severity: string;
          resource: string;
          entity: string | null;
          period: string | null;
          summary: string;
          detail: Json | null;
          first_seen_at: string;
          last_seen_at: string;
          resolved_at: string | null;
          notified_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          fingerprint?: string;
          kind?: string;
          severity?: string;
          resource?: string;
          entity?: string | null;
          period?: string | null;
          summary?: string;
          detail?: Json | null;
          first_seen_at?: string;
          last_seen_at?: string;
          resolved_at?: string | null;
          notified_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          fingerprint?: string;
          kind?: string;
          severity?: string;
          resource?: string;
          entity?: string | null;
          period?: string | null;
          summary?: string;
          detail?: Json | null;
          first_seen_at?: string;
          last_seen_at?: string;
          resolved_at?: string | null;
          notified_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      unit_snapshots: {
        Row: {
          snapshot_date: string;
          resman_unit_id: string;
          unit_number: string | null;
          resman_building_id: string | null;
          resman_floorplan_id: string | null;
          occupancy_status: string | null;
          occupied: boolean | null;
          lease_status: string | null;
          availability: string | null;
          balance: number | null;
          current_month_balance: number | null;
          market_rent: number | null;
          lease_rent: number | null;
          times_late: number | null;
          holding_unit: boolean | null;
          excluded_from_occupancy: boolean | null;
          move_in_date: string | null;
          move_out_date: string | null;
          lease_end_date: string | null;
          source: string;
          created_at: string;
        };
        Insert: {
          snapshot_date: string;
          resman_unit_id: string;
          unit_number?: string | null;
          resman_building_id?: string | null;
          resman_floorplan_id?: string | null;
          occupancy_status?: string | null;
          occupied?: boolean | null;
          lease_status?: string | null;
          availability?: string | null;
          balance?: number | null;
          current_month_balance?: number | null;
          market_rent?: number | null;
          lease_rent?: number | null;
          times_late?: number | null;
          holding_unit?: boolean | null;
          excluded_from_occupancy?: boolean | null;
          move_in_date?: string | null;
          move_out_date?: string | null;
          lease_end_date?: string | null;
          source?: string;
          created_at?: string;
        };
        Update: {
          snapshot_date?: string;
          resman_unit_id?: string;
          unit_number?: string | null;
          resman_building_id?: string | null;
          resman_floorplan_id?: string | null;
          occupancy_status?: string | null;
          occupied?: boolean | null;
          lease_status?: string | null;
          availability?: string | null;
          balance?: number | null;
          current_month_balance?: number | null;
          market_rent?: number | null;
          lease_rent?: number | null;
          times_late?: number | null;
          holding_unit?: boolean | null;
          excluded_from_occupancy?: boolean | null;
          move_in_date?: string | null;
          move_out_date?: string | null;
          lease_end_date?: string | null;
          source?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      property_snapshots: {
        Row: {
          snapshot_date: string;
          total_units: number | null;
          occupied_units: number | null;
          vacant_units: number | null;
          occupancy_pct: number | null;
          rent_roll: number | null;
          lease_rent_total: number | null;
          balance_total: number | null;
          balance_0_30: number | null;
          balance_31_60: number | null;
          balance_61_90: number | null;
          balance_90_plus: number | null;
          delinquent_units: number | null;
          turns_in_progress: number | null;
          open_work_orders: number | null;
          utility_due: number | null;
          source: "nightly" | "backfill";
          created_at: string | null;
        };
        Insert: {
          snapshot_date: string;
          total_units?: number | null;
          occupied_units?: number | null;
          vacant_units?: number | null;
          occupancy_pct?: number | null;
          rent_roll?: number | null;
          lease_rent_total?: number | null;
          balance_total?: number | null;
          balance_0_30?: number | null;
          balance_31_60?: number | null;
          balance_61_90?: number | null;
          balance_90_plus?: number | null;
          delinquent_units?: number | null;
          turns_in_progress?: number | null;
          open_work_orders?: number | null;
          utility_due?: number | null;
          source?: "nightly" | "backfill";
          created_at?: string | null;
        };
        Update: {
          snapshot_date?: string;
          total_units?: number | null;
          occupied_units?: number | null;
          vacant_units?: number | null;
          occupancy_pct?: number | null;
          rent_roll?: number | null;
          lease_rent_total?: number | null;
          balance_total?: number | null;
          balance_0_30?: number | null;
          balance_31_60?: number | null;
          balance_61_90?: number | null;
          balance_90_plus?: number | null;
          delinquent_units?: number | null;
          turns_in_progress?: number | null;
          open_work_orders?: number | null;
          utility_due?: number | null;
          source?: "nightly" | "backfill";
          created_at?: string | null;
        };
        Relationships: [];
      };
      mlgw_accounts: {
        Row: {
          id: string;
          resman_property_id: string;
          property_name: string;
          account_number: string;
          service_address: string;
          resman_unit_id: string;
          unit_number: string;
          is_house_account: boolean;
          due_now: number | null;
          due_date: string | null;
          synced_at: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id: string;
          resman_property_id?: string;
          property_name?: string;
          account_number?: string;
          service_address?: string;
          resman_unit_id?: string;
          unit_number?: string;
          is_house_account?: boolean;
          due_now?: number | null;
          due_date?: string | null;
          synced_at?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          resman_property_id?: string;
          property_name?: string;
          account_number?: string;
          service_address?: string;
          resman_unit_id?: string;
          unit_number?: string;
          is_house_account?: boolean;
          due_now?: number | null;
          due_date?: string | null;
          synced_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      mlgw_bills: {
        Row: {
          id: string;
          document_key: string;
          mlgw_account_id: string | null;
          resman_property_id: string;
          document_id: string;
          is_current: boolean;
          bill_date: string | null;
          due_date: string | null;
          amount_due: number | null;
          balance_forward: number | null;
          average_temperature: number | null;
          bill_for: string;
          file_path: string;
          gas_usage: string;
          gas_read_start_date: string | null;
          gas_read_end_date: string | null;
          gas_total: number | null;
          electric_usage: string;
          electric_read_start_date: string | null;
          electric_read_end_date: string | null;
          electric_total: number | null;
          water_usage: string;
          water_read_start_date: string | null;
          water_read_end_date: string | null;
          water_total: number | null;
          sewer_usage: string;
          sewer_read_start_date: string | null;
          sewer_read_end_date: string | null;
          sewer_total: number | null;
          other_mlgw_total: number | null;
          non_mlgw_total: number | null;
          street_light_fee_total: number | null;
          electrical_late_fee_total: number | null;
          security_deposit_total: number | null;
          smart_meter_connect_charge_total: number | null;
          credit_balance_transfer_total: number | null;
          share_the_pennies_total: number | null;
          water_cross_connection_fee_total: number | null;
          leasing_outdoor_lighting_total: number | null;
          mosquito_rodent_control_fee_total: number | null;
          sewer_charge_total: number | null;
          storm_water_fee_total: number | null;
          solid_waste_fee_total: number | null;
          synced_at: string | null;
          raw: Json | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id: string;
          document_key?: string;
          mlgw_account_id?: string | null;
          resman_property_id?: string;
          document_id?: string;
          is_current?: boolean;
          bill_date?: string | null;
          due_date?: string | null;
          amount_due?: number | null;
          balance_forward?: number | null;
          average_temperature?: number | null;
          bill_for?: string;
          file_path?: string;
          gas_usage?: string;
          gas_read_start_date?: string | null;
          gas_read_end_date?: string | null;
          gas_total?: number | null;
          electric_usage?: string;
          electric_read_start_date?: string | null;
          electric_read_end_date?: string | null;
          electric_total?: number | null;
          water_usage?: string;
          water_read_start_date?: string | null;
          water_read_end_date?: string | null;
          water_total?: number | null;
          sewer_usage?: string;
          sewer_read_start_date?: string | null;
          sewer_read_end_date?: string | null;
          sewer_total?: number | null;
          other_mlgw_total?: number | null;
          non_mlgw_total?: number | null;
          street_light_fee_total?: number | null;
          electrical_late_fee_total?: number | null;
          security_deposit_total?: number | null;
          smart_meter_connect_charge_total?: number | null;
          credit_balance_transfer_total?: number | null;
          share_the_pennies_total?: number | null;
          water_cross_connection_fee_total?: number | null;
          leasing_outdoor_lighting_total?: number | null;
          mosquito_rodent_control_fee_total?: number | null;
          sewer_charge_total?: number | null;
          storm_water_fee_total?: number | null;
          solid_waste_fee_total?: number | null;
          synced_at?: string | null;
          raw?: Json | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          document_key?: string;
          mlgw_account_id?: string | null;
          resman_property_id?: string;
          document_id?: string;
          is_current?: boolean;
          bill_date?: string | null;
          due_date?: string | null;
          amount_due?: number | null;
          balance_forward?: number | null;
          average_temperature?: number | null;
          bill_for?: string;
          file_path?: string;
          gas_usage?: string;
          gas_read_start_date?: string | null;
          gas_read_end_date?: string | null;
          gas_total?: number | null;
          electric_usage?: string;
          electric_read_start_date?: string | null;
          electric_read_end_date?: string | null;
          electric_total?: number | null;
          water_usage?: string;
          water_read_start_date?: string | null;
          water_read_end_date?: string | null;
          water_total?: number | null;
          sewer_usage?: string;
          sewer_read_start_date?: string | null;
          sewer_read_end_date?: string | null;
          sewer_total?: number | null;
          other_mlgw_total?: number | null;
          non_mlgw_total?: number | null;
          street_light_fee_total?: number | null;
          electrical_late_fee_total?: number | null;
          security_deposit_total?: number | null;
          smart_meter_connect_charge_total?: number | null;
          credit_balance_transfer_total?: number | null;
          share_the_pennies_total?: number | null;
          water_cross_connection_fee_total?: number | null;
          leasing_outdoor_lighting_total?: number | null;
          mosquito_rodent_control_fee_total?: number | null;
          sewer_charge_total?: number | null;
          storm_water_fee_total?: number | null;
          solid_waste_fee_total?: number | null;
          synced_at?: string | null;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "mlgw_bills_mlgw_account_id_fkey";
            columns: ["mlgw_account_id"];
            isOneToOne: false;
            referencedRelation: "mlgw_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      mlgw_payments: {
        Row: {
          id: string;
          mlgw_account_id: string | null;
          resman_property_id: string;
          account_number: string;
          reference_number: string;
          status: string;
          amount: number | null;
          paid_date: string | null;
          payment_method: string;
          authorization_number: string;
          account_selection: string;
          fetched_at: string | null;
          detail_fetched_at: string | null;
          detail_text: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id: string;
          mlgw_account_id?: string | null;
          resman_property_id?: string;
          account_number?: string;
          reference_number?: string;
          status?: string;
          amount?: number | null;
          paid_date?: string | null;
          payment_method?: string;
          authorization_number?: string;
          account_selection?: string;
          fetched_at?: string | null;
          detail_fetched_at?: string | null;
          detail_text?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          mlgw_account_id?: string | null;
          resman_property_id?: string;
          account_number?: string;
          reference_number?: string;
          status?: string;
          amount?: number | null;
          paid_date?: string | null;
          payment_method?: string;
          authorization_number?: string;
          account_selection?: string;
          fetched_at?: string | null;
          detail_fetched_at?: string | null;
          detail_text?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "mlgw_payments_mlgw_account_id_fkey";
            columns: ["mlgw_account_id"];
            isOneToOne: false;
            referencedRelation: "mlgw_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      mlgw_exception_reviews: {
        Row: {
          id: string;
          resman_property_id: string;
          bill_id: string;
          account_number: string;
          exception_kind: string;
          reviewed_at: string | null;
          created_at: string | null;
        };
        Insert: {
          id: string;
          resman_property_id?: string;
          bill_id?: string;
          account_number?: string;
          exception_kind?: string;
          reviewed_at?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          resman_property_id?: string;
          bill_id?: string;
          account_number?: string;
          exception_kind?: string;
          reviewed_at?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      resman_sync_runs: {
        Row: {
          id: string;
          job: string;
          resman_account_id: string | null;
          resman_property_id: string | null;
          status: "running" | "succeeded" | "failed" | "partial" | "skipped";
          started_at: string;
          finished_at: string | null;
          rows_upserted: number;
          rows_failed: number;
          error: string | null;
          metadata: Json;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          job: string;
          resman_account_id?: string | null;
          resman_property_id?: string | null;
          status: "running" | "succeeded" | "failed" | "partial" | "skipped";
          started_at?: string;
          finished_at?: string | null;
          rows_upserted?: number;
          rows_failed?: number;
          error?: string | null;
          metadata?: Json;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          job?: string;
          resman_account_id?: string | null;
          resman_property_id?: string | null;
          status?: "running" | "succeeded" | "failed" | "partial" | "skipped";
          started_at?: string;
          finished_at?: string | null;
          rows_upserted?: number;
          rows_failed?: number;
          error?: string | null;
          metadata?: Json;
        };
        Relationships: [];
      };
      resman_sync_state: {
        Row: {
          job: string;
          resman_property_id: string;
          last_synced_at: string | null;
          last_run_id: string | null;
          cursor: Json;
          updated_at: string | null;
        };
        Insert: {
          job: string;
          resman_property_id?: string;
          last_synced_at?: string | null;
          last_run_id?: string | null;
          cursor?: Json;
          updated_at?: string | null;
        };
        Update: {
          job?: string;
          resman_property_id?: string;
          last_synced_at?: string | null;
          last_run_id?: string | null;
          cursor?: Json;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resman_sync_state_last_run_id_fkey";
            columns: ["last_run_id"];
            isOneToOne: false;
            referencedRelation: "resman_sync_runs";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      check_rate_limit: {
        Args: {
          p_bucket: string;
          p_max_attempts: number;
          p_window_seconds: number;
        };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
  };
}
